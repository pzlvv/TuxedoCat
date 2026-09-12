import { useState, useMemo, useCallback } from 'react';

export function useConversationTree(conversations: Array<any>) {
  const [expandedSubSessions, setExpandedSubSessions] = useState<Record<string, boolean>>({});

  const conversationTree = useMemo(() => {
    const childrenMap = new Map<string, any[]>();
    const roots: any[] = [];
    // 先建 sessionId 索引，避免在循环内对 conversations 做 O(n) 的 some() 查找（O(n²)）
    const sessionIds = new Set(conversations.map((c: any) => c.sessionId));

    for (const item of conversations) {
      const parentId = item.parentSessionId;
      if (parentId && sessionIds.has(parentId)) {
        // Has a valid parent, grouped as child
        if (!childrenMap.has(parentId)) {
          childrenMap.set(parentId, []);
        }
        childrenMap.get(parentId)!.push(item);
      } else {
        // Root node
        roots.push(item);
      }
    }

    // Sort each group by updatedAt (last user message) descending, fallback to createdAt
    const byUpdatedAt = (a: any, b: any) =>
      (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt);
    roots.sort(byUpdatedAt);
    for (const [, children] of childrenMap) {
      children.sort(byUpdatedAt);
    }

    return { roots, childrenMap };
  }, [conversations]);

  const toggleSubSession = useCallback((sessionId: string) => {
    setExpandedSubSessions((prev) => ({
      ...prev,
      [sessionId]: !prev[sessionId],
    }));
  }, []);

  return {
    conversationTree,
    toggleSubSession,
    expandedSubSessions,
    setExpandedSubSessions,
  };
}
