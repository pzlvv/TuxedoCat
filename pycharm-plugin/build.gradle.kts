import groovy.json.JsonSlurper
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.util.Properties

/**
 * PyCharm 插件宿主构建（specs/035）。
 *
 * 产品身份唯一来源：`../src/config/project.json` 与 `../package.json`（docs/hosts/product-identity.md），
 * 本文件与源码树内零品牌字面量——plugin.xml 用 ${} 令牌经 processResources 展开，
 * Kotlin 侧身份常量由 generateProductIdentity 任务生成到 build/（不入库）。
 *
 * 机器相关覆盖放 `local.properties`（gitignore，见 local.properties.example）：
 * - `pycharmLocalPath`：本机 PyCharm 安装目录（intellijPlatform local 依赖，免下载整平台；
 *   缺省走远程坐标，见 e2e/environments.json 的 pycharm 段同源）。
 */
val repoRoot: File = rootDir.parentFile

val projectIdentity = JsonSlurper().parseText(repoRoot.resolve("src/config/project.json").readText()) as Map<*, *>
val packageIdentity = JsonSlurper().parseText(repoRoot.resolve("package.json").readText()) as Map<*, *>

val localProps = Properties().apply {
    val f = rootDir.resolve("local.properties")
    if (f.isFile) f.inputStream().use { load(it) }
}
val pycharmLocalPath: String? =
    localProps.getProperty("pycharmLocalPath") ?: System.getenv("PYCHARM_LOCAL_IDE")

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.3.21"
    id("org.jetbrains.intellij.platform") version "2.7.0"
}

group = projectIdentity["publisher"] as String
version = packageIdentity["version"] as String

repositories {
    maven("https://maven.aliyun.com/repository/public")
    // defaultRepositories() 注册 JetBrains 仓库与 local() 本地 IDE 组件仓库——缺了它
    // local() 依赖会被当普通 maven 坐标去仓库里找（实测报 localIde:PY:... not found）
    intellijPlatform { defaultRepositories() }
    mavenCentral()
}

dependencies {
    intellijPlatform {
        // 平台依赖与 e2e 验收环境严格一致（plan「构建平台与工具链」）：本机安装优先
        if (pycharmLocalPath != null) local(pycharmLocalPath) else create("PY", "2026.2.4")
        // JCEF API（com.intellij.ui.jcef）已抽出平台、落在 bundled plugin 里，编译与运行都依赖它
        bundledPlugin("com.intellij.modules.jcef")
    }
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")
    testImplementation(kotlin("test"))
}

java {
    // 2026.2 平台类文件为 Java 25（product-info.json minRequiredJavaVersion=25）；
    // 用 JDK 25 编译、产出 Java 17 字节码以兑现 since-build 241 声明。
    // 需以 JDK 25 运行 Gradle（build-pycharm.mjs 会设 JAVA_HOME；或 local.properties 的 jdk25Path）。
    toolchain {
        languageVersion = JavaLanguageVersion.of(25)
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
    }
}

tasks.withType<JavaCompile>().configureEach {
    // 与 Kotlin jvmTarget 对齐：JDK 25 编译、release 17 产出（since-build 241 的 JBR 17 可加载）
    options.release.set(17)
}

intellijPlatform {
    // 本地 IDE 安装不提供 searchable options 的生成输入（那需要完整发行版的产物树），
    // 且面板复用 webview 自带的文案检索，不需要 IDE 内置检索索引——直接关闭
    buildSearchableOptions = false
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "241"
            untilBuild = "262.*"
        }
    }
}

// ===== 身份生成：ProductIdentity.kt（build/generated，不入库）=====
val generateProductIdentity by tasks.registering {
    val outDir = layout.buildDirectory.dir("generated-sources/productIdentity")
    outputs.dir(outDir)
    inputs.file(repoRoot.resolve("src/config/project.json"))
    doLast {
        val dir = outDir.get().asFile.resolve("pycharm/host")
        dir.mkdirs()
        val extensionName = projectIdentity["extensionName"] as String
        dir.resolve("ProductIdentity.kt").writeText(
            """
            |// 由 Gradle 任务 generateProductIdentity 生成，来源 src/config/project.json；勿手改。
            |package pycharm.host
            |
            |object ProductIdentity {
            |    const val PRODUCT_NAME: String = "${projectIdentity["productName"]}"
            |    const val EXTENSION_NAME: String = "$extensionName"
            |    const val PUBLISHER: String = "${projectIdentity["publisher"]}"
            |    const val CONFIG_DIR_NAME: String = "${projectIdentity["configDir"]}"
            |    const val CORE_BINARY_NAME: String = "${(projectIdentity["core"] as Map<*, *>)["binaryName"]}"
            |    const val CORE_RESOURCE_DIR: String = "${(projectIdentity["core"] as Map<*, *>)["resourceDir"]}"
            |
            |    /** webview 自定义 scheme（CEF scheme 只允许字母数字）：扩展名去分隔符 */
            |    const val WEBVIEW_SCHEME: String = "${extensionName.replace(Regex("[^a-zA-Z0-9]"), "")}"
            |}
            """.trimMargin(),
        )
    }
}

// ===== 图标派生（FR-007）：单一来源 assets/logo.svg，复制为两落点，不入库 =====
val derivePluginIcon by tasks.registering(Copy::class) {
    from(repoRoot.resolve("assets/logo.svg"))
    into(layout.buildDirectory.dir("generated-resources/icons/META-INF"))
    rename { "pluginIcon.svg" }
}
val deriveToolWindowIcon by tasks.registering(Copy::class) {
    from(repoRoot.resolve("assets/logo.svg"))
    into(layout.buildDirectory.dir("generated-resources/icons/icons"))
    rename { "toolWindow.svg" }
}

sourceSets.main {
    kotlin.srcDir(layout.buildDirectory.dir("generated-sources/productIdentity"))
    resources.srcDir(layout.buildDirectory.dir("generated-resources/icons"))
}

tasks {
    compileKotlin { dependsOn(generateProductIdentity) }
    processResources {
        dependsOn(derivePluginIcon, deriveToolWindowIcon)
        filesMatching("plugin.xml") {
            expand(
                "pluginId" to "${projectIdentity["extensionName"]}.pycharm",
                "productName" to projectIdentity["productName"],
                "publisher" to projectIdentity["publisher"],
                "toolWindowId" to projectIdentity["productName"],
            )
        }
    }
}
