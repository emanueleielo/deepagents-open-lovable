import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { Sidebar } from '../components/layout/Sidebar';
import { ChatArea } from '../components/chat/ChatArea';
import { RightPanel } from '../components/layout/RightPanel';
import { useChat } from '../hooks/useChat';
import { useThreadHistory } from '../hooks/useThreadHistory';
import { useFileChangeDetection } from '../hooks/useFileChangeDetection';
import { useFileTree } from '../hooks/useFileTree';
import { normalizeFiles, getMessageText } from '../types';
import type { FileNode, Message } from '../types';

export function ThreadView(): JSX.Element {
  const { threadId: paramThreadId } = useParams<{ threadId: string }>();

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

  const [writingStatus, setWritingStatus] = useState<string | null>(null);

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

  // Detect file changes for auto-selection and animation
  // Now returns all changes, not just the last one
  const { allChanges, changesCount } = useFileChangeDetection(files, isLoading);

  // Use the optimized file tree hook that handles:
  // - Incremental tree updates (only rebuild when structure changes)
  // - Synchronized auto-selection (no race conditions)
  // - Animation state management
  const {
    fileTree,
    selectedNode,
    setSelectedNode,
    animatingFilePath,
    animatingPreviousContent,
  } = useFileTree({
    files,
    allChanges,
    isLoading,
  });

  // Update writing status when loading - show file count if multiple files changed
  useEffect(() => {
    if (isLoading) {
      if (changesCount > 1) {
        setWritingStatus(`Working (${changesCount} files)`);
      } else {
        setWritingStatus('Working');
      }
    } else {
      setWritingStatus(null);
    }
  }, [isLoading, changesCount]);

  const handleNewThread = () => {
    // Clear the threadId query param and navigate to /new
    // Force page reload to reset the chat state completely
    window.location.href = '/new';
  };

  const handleSelectThread = (selectedThreadId: string) => {
    // Use setThreadId directly to switch threads - this updates nuqs state
    // which triggers useStream to load the new thread
    setThreadId(selectedThreadId);
  };

  const handleSelectNode = useCallback((node: FileNode) => {
    // setSelectedNode from useFileTree already handles clearing auto-selection
    setSelectedNode(node);
  }, [setSelectedNode]);

  const handleAskToFix = useCallback((error: string) => {
    const message = `The Vercel deployment failed with the following error:\n\n\`\`\`\n${error}\n\`\`\`\n\nPlease fix this error so the preview can be deployed successfully.\n\nIf these logs are not sufficient to understand the issue, use the \`build_app\` tool to run a local build and get more detailed error messages.`;
    sendMessage(message);
  }, [sendMessage]);

  return (
    <div className="mac-window flex overflow-hidden text-gray-200 font-sans selection:bg-primary selection:text-white relative">
      {/* Sidebar */}
      <Sidebar
        threads={threads}
        currentThreadId={threadId || paramThreadId || null}
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
          threadId={threadId || paramThreadId || null}
          onSelectNode={handleSelectNode}
          animatingFilePath={animatingFilePath}
          animatingPreviousContent={animatingPreviousContent}
          onAskToFix={handleAskToFix}
        />
      </div>
    </div>
  );
}
