pluginManagement {
    repositories {
        // 镜像优先（本机网络到 plugins.gradle.org 直连不稳，见 specs/035 plan「构建平台与工具链」）
        maven("https://maven.aliyun.com/repository/gradle-plugin")
        maven("https://cache-redirector.jetbrains.com/plugins.gradle.org/m2/")
        gradlePluginPortal()
    }
}

rootProject.name = "pycharm-plugin"
