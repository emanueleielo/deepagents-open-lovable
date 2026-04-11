import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { flatFilesToTree, getFilesHash, findNodeByPath, pathToId, updateTreeContent } from '../utils/fileTree';
import type { FileNode } from '../types';
import type { FileChange } from './useFileChangeDetection';

interface UseFileTreeOptions {
  files: Record<string, string>;
  allChanges: FileChange[];
  isLoading: boolean;
}

interface UseFileTreeResult {
  fileTree: FileNode[];
  selectedNode: FileNode | null;
  setSelectedNode: (node: FileNode | null) => void;
  autoSelectedPath: string | null;
  animatingFilePath: string | null;
  animatingPreviousContent: string;
}

/**
 * Optimized hook for managing file tree with:
 * - Incremental tree updates (only rebuild when structure changes)
 * - Synchronized auto-selection (no race conditions)
 * - Animation state management
 */
export function useFileTree({
  files,
  allChanges,
  isLoading,
}: UseFileTreeOptions): UseFileTreeResult {
  const [selectedNode, setSelectedNode] = useState<FileNode | null>(null);
  const [autoSelectedPath, setAutoSelectedPath] = useState<string | null>(null);

  // Track previous structure hash to detect when we need full rebuild
  const prevStructureHashRef = useRef<string>('');
  const fileTreeRef = useRef<FileNode[]>([]);
  const lastProcessedChangeIndexRef = useRef<number>(0);

  // Compute file tree with incremental updates when possible
  const fileTree = useMemo(() => {
    const currentHash = getFilesHash(files);

    // If structure changed (new/deleted files), do full rebuild
    if (currentHash !== prevStructureHashRef.current) {
      prevStructureHashRef.current = currentHash;
      fileTreeRef.current = flatFilesToTree(files);
      return fileTreeRef.current;
    }

    // Structure same, check if we need content updates
    const newChanges = allChanges.slice(lastProcessedChangeIndexRef.current);
    if (newChanges.length > 0) {
      const changedPaths = newChanges
        .filter(c => c.type === 'modified')
        .map(c => c.path);

      if (changedPaths.length > 0) {
        fileTreeRef.current = updateTreeContent(
          fileTreeRef.current,
          files,
          changedPaths
        );
      }
      lastProcessedChangeIndexRef.current = allChanges.length;
    }

    return fileTreeRef.current;
  }, [files, allChanges]);

  // Track the latest change for animation
  const latestChange = allChanges.length > 0 ? allChanges[allChanges.length - 1] : null;

  // Auto-select changed file during loading - synchronized with tree building
  useEffect(() => {
    if (!isLoading) {
      setAutoSelectedPath(null);
      lastProcessedChangeIndexRef.current = 0;
      return;
    }

    if (latestChange && isLoading) {
      const node = findNodeByPath(fileTree, latestChange.path);
      if (node) {
        setSelectedNode(node);
        setAutoSelectedPath(latestChange.path);
      }
    }
  }, [latestChange, isLoading, fileTree]);

  // Auto-select first file when tree becomes non-empty and nothing selected
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

  // Handle manual selection (clears auto-selection)
  const handleSetSelectedNode = useCallback((node: FileNode | null) => {
    setSelectedNode(node);
    setAutoSelectedPath(null);
  }, []);

  // Calculate animation props
  const animatingFilePath = useMemo(() => {
    if (!autoSelectedPath || !isLoading) return null;
    return pathToId(autoSelectedPath);
  }, [autoSelectedPath, isLoading]);

  const animatingPreviousContent = useMemo(() => {
    if (!autoSelectedPath || !latestChange) return '';
    if (autoSelectedPath === latestChange.path) {
      return latestChange.previousContent;
    }
    return '';
  }, [autoSelectedPath, latestChange]);

  return {
    fileTree,
    selectedNode,
    setSelectedNode: handleSetSelectedNode,
    autoSelectedPath,
    animatingFilePath,
    animatingPreviousContent,
  };
}
