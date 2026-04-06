import { useState, useEffect, useMemo, useCallback } from 'react';
import { Sidebar } from '../components/layout/Sidebar';
import { ChatArea } from '../components/chat/ChatArea';
import { RightPanel } from '../components/layout/RightPanel';
import { useChat } from '../hooks/useChat';
import { useThreadHistory } from '../hooks/useThreadHistory';
import { useFileChangeDetection } from '../hooks/useFileChangeDetection';
import { flatFilesToTree, findNodeByPath, pathToId } from '../utils/fileTree';
import { normalizeFiles, getMessageText } from '../types';
import type { FileNode, Message } from '../types';

export function NewThread(): JSX.Element {
  const {
    threads,
    isLoading: isLoadingThreads,
    refetch: refetchThreads,
  } = useThreadHistory({ assistantId: 'frontend' });

  const {
    messages: rawMessages,
    files: rawFiles,
    todos,
    isLoading,
    isThreadLoading,
    threadId,
    setThreadId,
    sendMessage,
    stopStream,
  } = useChat({
    assistantId: 'frontend',
    onHistoryRevalidate: refetchThreads,
  });

  const [selectedNode, setSelectedNode] = useState<FileNode | null>(null);
  const [writingStatus, setWritingStatus] = useState<string | null>(null);
  // Track if current selection was auto-selected (for animation purposes)
  const [autoSelectedPath, setAutoSelectedPath] = useState<string | null>(null);

  // Normalize messages from LangGraph SDK format to UI format
  const messages: Message[] = useMemo(() => {
    return rawMessages.map((msg, idx) => {
      let role: Message['role'] = 'assistant';
      if (msg.type === 'human') {
        role = 'user';
      } else if (msg.type === 'tool') {
        role = 'tool';
      }

      // Extract tool calls if they exist (only on AI messages)
      const msgAny = msg as Record<string, unknown>;

      return {
        id: msg.id || `msg_${idx}`,
        role,
        content: getMessageText(msg.content),
        toolCalls: msgAny.tool_calls as Message['toolCalls'],
        toolCallId: msgAny.tool_call_id as string | undefined,
        toolName: msgAny.name as string | undefined,
      };
    });
  }, [rawMessages]);

  // Normalize files
  const files = useMemo(() => {
    return normalizeFiles(rawFiles);
  }, [rawFiles]);

  // Build file tree from flat files (excludes /memory/ files)
  const fileTree = useMemo(() => {
    return flatFilesToTree(files);
  }, [files]);

  // Detect file changes for auto-selection and animation
  const { changedFilePath, previousContent } = useFileChangeDetection(files, isLoading);

  // Auto-select file when it's being created/modified
  useEffect(() => {
    if (changedFilePath && isLoading) {
      const node = findNodeByPath(fileTree, changedFilePath);
      if (node) {
        setSelectedNode(node);
        setAutoSelectedPath(changedFilePath);
      }
    }
  }, [changedFilePath, isLoading, fileTree]);

  // Clear auto-selection when loading finishes
  useEffect(() => {
    if (!isLoading) {
      setAutoSelectedPath(null);
    }
  }, [isLoading]);

  // Calculate animation props
  const animatingFilePath = autoSelectedPath && isLoading ? pathToId(autoSelectedPath) : null;
  const animatingPreviousContent = autoSelectedPath === changedFilePath ? previousContent : '';

  // Update writing status when loading
  useEffect(() => {
    if (isLoading) {
      setWritingStatus('Working');
    } else {
      setWritingStatus(null);
    }
  }, [isLoading]);

  // Auto-select first file when file tree changes
  useEffect(() => {
    if (fileTree.length > 0 && !selectedNode) {
      const findFirstFile = (nodes: FileNode[]): FileNode | null => {
        for (const node of nodes) {
          if (node.type !== 'folder') return node;
          if (node.children) {
            const found = findFirstFile(node.children);
            if (found) return found;
          }
        }
        return null;
      };
      const firstFile = findFirstFile(fileTree);
      if (firstFile) setSelectedNode(firstFile);
    }
  }, [fileTree, selectedNode]);

  const handleNewThread = () => {
    // Force page reload to reset the chat state completely
    window.location.href = '/new';
  };

  const handleSelectThread = (selectedThreadId: string) => {
    // Use setThreadId directly to switch threads - this updates nuqs state
    // which triggers useStream to load the new thread
    setThreadId(selectedThreadId);
  };

  const handleSelectNode = (node: FileNode) => {
    setSelectedNode(node);
    // Manual selection clears auto-selection (stops animation for that file)
    setAutoSelectedPath(null);
  };

  const handleAskToFix = useCallback((error: string) => {
    const message = `The Vercel deployment failed with the following error:\n\n\`\`\`\n${error}\n\`\`\`\n\nPlease fix this error so the preview can be deployed successfully.`;
    sendMessage(message);
  }, [sendMessage]);

  return (
    <div className="mac-window flex overflow-hidden text-gray-200 font-sans selection:bg-primary selection:text-white relative">
      {/* Sidebar */}
      <Sidebar
        threads={threads}
        currentThreadId={threadId}
        isLoadingThreads={isLoadingThreads}
        onSelectThread={handleSelectThread}
        onNewThread={handleNewThread}
      />

      {/* Main Content */}
      <div className="flex-1 flex flex-row bg-transparent overflow-hidden">
        {/* Chat */}
        <ChatArea
          messages={messages}
          isLoading={isLoading}
          isThreadLoading={isThreadLoading}
          writingStatus={writingStatus}
          onSendMessage={sendMessage}
          onStop={stopStream}
        />

        {/* Right Panel */}
        <RightPanel
          fileTree={fileTree}
          files={files}
          selectedNode={selectedNode}
          streamingFileId={isLoading ? 'streaming' : null}
          todos={todos}
          threadId={threadId}
          onSelectNode={handleSelectNode}
          animatingFilePath={animatingFilePath}
          animatingPreviousContent={animatingPreviousContent}
          onAskToFix={handleAskToFix}
        />
      </div>
    </div>
  );
}
