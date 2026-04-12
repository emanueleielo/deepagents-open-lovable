/**
 * Vercel API client for programmatic deployments
 * Uses the Vite proxy at /vercel-api to handle CORS and authentication
 */

import { normalizeFilePath, prepareFilesForDeploy } from '../utils/vercelFiles';

export interface VercelFile {
  file: string; // base64 encoded content
  encoding?: 'base64' | 'utf-8';
}

export interface DeploymentRequest {
  name: string;
  files: Record<string, VercelFile>;
  projectSettings?: {
    framework?: 'nextjs' | 'vite' | 'remix' | null;
    buildCommand?: string;
    outputDirectory?: string;
    installCommand?: string;
    devCommand?: string;
  };
  target?: 'production' | 'staging';
}

export interface DeploymentResponse {
  id: string;
  url: string;
  name: string;
  state: 'QUEUED' | 'BUILDING' | 'READY' | 'ERROR' | 'CANCELED';
  readyState: 'QUEUED' | 'BUILDING' | 'READY' | 'ERROR' | 'CANCELED';
  createdAt: number;
  buildingAt?: number;
  ready?: number;
  error?: {
    code: string;
    message: string;
  };
}

export interface DeploymentStatus {
  id: string;
  state: DeploymentResponse['state'];
  readyState: DeploymentResponse['readyState'];
  url: string;
  inspectorUrl?: string;
  buildLogs?: string[];
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Check if Vercel is configured (token is set)
 */
export function isVercelConfigured(): boolean {
  const value = import.meta.env.VITE_VERCEL_CONFIGURED;
  // Handle both boolean and string values (Vite define can behave differently)
  return value === true || value === 'true';
}

/**
 * Convert files to Vercel API format (base64 encoded)
 */
export function prepareFilesForVercel(
  files: Record<string, string>
): Record<string, VercelFile> {
  const vercelFiles: Record<string, VercelFile> = {};

  for (const [path, content] of Object.entries(files)) {
    const normalizedPath = normalizeFilePath(path);

    vercelFiles[normalizedPath] = {
      file: btoa(unescape(encodeURIComponent(content))),
      encoding: 'base64',
    };
  }

  return vercelFiles;
}

/**
 * Create a new deployment on Vercel
 */
export async function createDeployment(
  request: DeploymentRequest
): Promise<DeploymentResponse> {
  const response = await fetch('/vercel-api/v13/deployments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: request.name,
      files: Object.entries(request.files).map(([path, file]) => ({
        file: path,
        data: file.file,
        encoding: file.encoding || 'base64',
      })),
      projectSettings: request.projectSettings || {
        framework: 'nextjs',
      },
      // Omit target to create a preview deployment (not linked to production)
      ...(request.target && { target: request.target }),
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(`Vercel API error: ${error.error?.message || error.message || 'Unknown error'}`);
  }

  return response.json();
}

/**
 * Get deployment status
 */
export async function getDeploymentStatus(
  deploymentId: string
): Promise<DeploymentStatus> {
  const response = await fetch(`/vercel-api/v13/deployments/${deploymentId}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(`Vercel API error: ${error.error?.message || error.message || 'Unknown error'}`);
  }

  const data = await response.json();

  return {
    id: data.id,
    state: data.state,
    readyState: data.readyState,
    url: data.url,
    inspectorUrl: data.inspectorUrl,
    error: data.error,
  };
}

/**
 * Get deployment build logs/events
 * Returns the build output which contains error messages
 */
export async function getDeploymentEvents(
  deploymentId: string
): Promise<string[]> {
  try {
    const response = await fetch(`/vercel-api/v2/deployments/${deploymentId}/events`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return [];
    }

    const events = await response.json();

    // Extract text from build events
    const logs: string[] = [];
    if (Array.isArray(events)) {
      for (const event of events) {
        if (event.text) {
          logs.push(event.text);
        }
        // Also capture payload text if present
        if (event.payload?.text) {
          logs.push(event.payload.text);
        }
      }
    }

    return logs;
  } catch {
    return [];
  }
}

/**
 * Assign an alias to a deployment
 * This creates a public URL like "my-project.vercel.app" for the deployment
 */
export async function assignAlias(
  deploymentId: string,
  alias: string
): Promise<{ uid: string; alias: string; created: string }> {
  const response = await fetch(`/vercel-api/v2/deployments/${deploymentId}/aliases`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ alias }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(`Failed to assign alias: ${error.error?.message || error.message || 'Unknown error'}`);
  }

  return response.json();
}

/**
 * Poll deployment status until ready or error
 */
export async function waitForDeployment(
  deploymentId: string,
  onStatusUpdate?: (status: DeploymentStatus) => void,
  maxWaitMs: number = 300000, // 5 minutes
  pollIntervalMs: number = 3000
): Promise<DeploymentStatus> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const status = await getDeploymentStatus(deploymentId);

    if (onStatusUpdate) {
      onStatusUpdate(status);
    }

    if (status.readyState === 'READY') {
      return status;
    }

    if (status.readyState === 'ERROR' || status.readyState === 'CANCELED') {
      // Fetch build logs to get the full error message
      const buildLogs = await getDeploymentEvents(deploymentId);

      // Look for error lines in the build logs
      const errorLines = buildLogs.filter(line =>
        line.toLowerCase().includes('error') ||
        line.toLowerCase().includes('failed') ||
        line.includes('ERR!') ||
        line.includes('ERROR') ||
        line.includes('TypeError') ||
        line.includes('SyntaxError') ||
        line.includes('ReferenceError') ||
        line.includes('Module not found') ||
        line.includes('Cannot find')
      );

      // Build a comprehensive error message
      let fullError = status.error?.message || `Deployment ${status.readyState.toLowerCase()}`;

      if (errorLines.length > 0) {
        // Take the last 30 error lines to capture the most relevant errors
        const relevantErrors = errorLines.slice(-30).join('\n');
        fullError = `${fullError}\n\nBuild output:\n${relevantErrors}`;
      } else if (buildLogs.length > 0) {
        // If no specific error lines found, take the last 20 lines of logs
        const lastLogs = buildLogs.slice(-20).join('\n');
        fullError = `${fullError}\n\nBuild output:\n${lastLogs}`;
      }

      throw new Error(fullError);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error('Deployment timed out');
}

/**
 * Deploy files to Vercel with automatic polling and alias assignment
 */
export async function deployToVercel(
  files: Record<string, string>,
  projectName: string,
  onStatusUpdate?: (status: DeploymentStatus) => void
): Promise<DeploymentStatus> {
  // Prepare files - add missing config files and normalize paths
  const preparedFiles = prepareFilesForDeploy(files);

  // Convert to Vercel format (base64)
  const vercelFiles = prepareFilesForVercel(preparedFiles);

  // Create deployment (no target = preview deployment)
  const deployment = await createDeployment({
    name: projectName,
    files: vercelFiles,
    projectSettings: {
      framework: 'nextjs',
      buildCommand: 'npm run build',
      installCommand: 'npm install',
    },
  });

  // Initial status update
  if (onStatusUpdate) {
    onStatusUpdate({
      id: deployment.id,
      state: deployment.state,
      readyState: deployment.readyState,
      url: deployment.url,
    });
  }

  // Wait for deployment to be ready
  const finalStatus = await waitForDeployment(deployment.id, onStatusUpdate);

  // Assign a clean public alias (e.g., "preview-123456789.vercel.app")
  // This makes the deployment accessible without the hash in the URL
  try {
    const cleanAlias = `${projectName}.vercel.app`;
    await assignAlias(finalStatus.id, cleanAlias);

    // Update the URL to use the clean alias
    finalStatus.url = cleanAlias;
  } catch (aliasError) {
    // Alias assignment failed, but deployment succeeded
    // Log the error but don't fail the deployment
    console.warn('Failed to assign alias, using default URL:', aliasError);
  }

  return finalStatus;
}
