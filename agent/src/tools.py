"""Custom tools for the frontend agent."""

import os
import shutil
import subprocess
import tempfile
from typing import Any, Literal

import requests
from langchain.tools import ToolRuntime
from langchain_core.tools import StructuredTool, tool
from markdownify import markdownify
from tavily import TavilyClient

# Initialize Tavily client if API key is available
_tavily_api_key = os.environ.get("TAVILY_API_KEY")
tavily_client = TavilyClient(api_key=_tavily_api_key) if _tavily_api_key else None


@tool
def http_request(
    url: str,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    data: str | dict | None = None,
    params: dict[str, str] | None = None,
    timeout: int = 30,
) -> dict[str, Any]:
    """Make HTTP requests to APIs and web services.

    Args:
        url: Target URL
        method: HTTP method (GET, POST, PUT, DELETE, etc.)
        headers: HTTP headers to include
        data: Request body data (string or dict)
        params: URL query parameters
        timeout: Request timeout in seconds

    Returns:
        Dictionary with response data including status, headers, and content
    """
    try:
        kwargs: dict[str, Any] = {"url": url, "method": method.upper(), "timeout": timeout}

        if headers:
            kwargs["headers"] = headers
        if params:
            kwargs["params"] = params
        if data:
            if isinstance(data, dict):
                kwargs["json"] = data
            else:
                kwargs["data"] = data

        response = requests.request(**kwargs)

        try:
            content = response.json()
        except Exception:
            content = response.text

        return {
            "success": response.status_code < 400,
            "status_code": response.status_code,
            "headers": dict(response.headers),
            "content": content,
            "url": response.url,
        }

    except requests.exceptions.Timeout:
        return {
            "success": False,
            "status_code": 0,
            "headers": {},
            "content": f"Request timed out after {timeout} seconds",
            "url": url,
        }
    except requests.exceptions.RequestException as e:
        return {
            "success": False,
            "status_code": 0,
            "headers": {},
            "content": f"Request error: {e!s}",
            "url": url,
        }
    except Exception as e:
        return {
            "success": False,
            "status_code": 0,
            "headers": {},
            "content": f"Error making request: {e!s}",
            "url": url,
        }


@tool
def web_search(
    query: str,
    max_results: int = 5,
    topic: Literal["general", "news", "finance"] = "general",
    include_raw_content: bool = False,
) -> dict[str, Any]:
    """Search the web using Tavily for current information and documentation.

    This tool searches the web and returns relevant results. After receiving results,
    you MUST synthesize the information into a natural, helpful response for the user.

    Args:
        query: The search query (be specific and detailed)
        max_results: Number of results to return (default: 5)
        topic: Search topic type - "general" for most queries, "news" for current events
        include_raw_content: Include full page content (warning: uses more tokens)

    Returns:
        Dictionary containing:
        - results: List of search results, each with:
            - title: Page title
            - url: Page URL
            - content: Relevant excerpt from the page
            - score: Relevance score (0-1)
        - query: The original search query

    IMPORTANT: After using this tool:
    1. Read through the 'content' field of each result
    2. Extract relevant information that answers the user's question
    3. Synthesize this into a clear, natural language response
    4. Cite sources by mentioning the page titles or URLs
    5. NEVER show the raw JSON to the user - always provide a formatted response
    """
    if tavily_client is None:
        return {
            "error": "Tavily API key not configured. Please set TAVILY_API_KEY environment variable.",
            "query": query,
        }

    try:
        return tavily_client.search(
            query,
            max_results=max_results,
            include_raw_content=include_raw_content,
            topic=topic,
        )
    except Exception as e:
        return {"error": f"Web search error: {e!s}", "query": query}


@tool
def fetch_url(url: str, timeout: int = 30) -> dict[str, Any]:
    """Fetch content from a URL and convert HTML to markdown format.

    This tool fetches web page content and converts it to clean markdown text,
    making it easy to read and process HTML content. After receiving the markdown,
    you MUST synthesize the information into a natural, helpful response for the user.

    Args:
        url: The URL to fetch (must be a valid HTTP/HTTPS URL)
        timeout: Request timeout in seconds (default: 30)

    Returns:
        Dictionary containing:
        - success: Whether the request succeeded
        - url: The final URL after redirects
        - markdown_content: The page content converted to markdown
        - status_code: HTTP status code
        - content_length: Length of the markdown content in characters

    IMPORTANT: After using this tool:
    1. Read through the markdown content
    2. Extract relevant information that answers the user's question
    3. Synthesize this into a clear, natural language response
    4. NEVER show the raw markdown to the user unless specifically requested
    """
    try:
        response = requests.get(
            url,
            timeout=timeout,
            headers={"User-Agent": "Mozilla/5.0 (compatible; DeepAgents/1.0)"},
        )
        response.raise_for_status()

        # Convert HTML content to markdown
        markdown_content = markdownify(response.text)

        return {
            "success": True,
            "url": str(response.url),
            "markdown_content": markdown_content,
            "status_code": response.status_code,
            "content_length": len(markdown_content),
        }
    except Exception as e:
        return {"success": False, "error": f"Fetch URL error: {e!s}", "url": url}


BUILD_APP_DESCRIPTION = """Build and verify the Next.js application to check for compilation errors.

This tool automatically reads all files from the current state, writes them to a
temporary directory, runs npm install and npm run build, and returns the build
output including any errors.

You do NOT need to read files before calling this tool - it has direct access
to all files in the state.

Returns:
    Dictionary containing:
    - success: Whether the build succeeded (boolean)
    - install_output: Output from npm install
    - build_output: Output from npm run build
    - errors: List of error messages if build failed
    - warnings: List of warning messages

IMPORTANT: Always call this tool after finishing your code to verify:
1. All dependencies can be installed
2. TypeScript compiles without errors
3. Next.js build succeeds
4. No missing imports or type errors

If the build fails, read the errors carefully and fix them before telling
the user the code is ready."""


def _build_app_impl(runtime: ToolRuntime) -> dict[str, Any]:
    """Internal implementation of build_app that accesses files from state."""
    # Get files directly from state - no need for agent to pass them
    state_files = runtime.state.get("files", {})

    if not state_files:
        return {
            "success": False,
            "install_output": "",
            "build_output": "",
            "errors": ["No files found in state. Create some files first."],
            "warnings": [],
        }

    temp_dir = None
    try:
        # Create temporary directory
        temp_dir = tempfile.mkdtemp(prefix="nextjs-build-")

        # Write files to temp directory
        for file_path, file_data in state_files.items():
            # Skip non-app files (like /memory/)
            if file_path.startswith("/memory/"):
                continue

            # Convert file data to string content
            # State files have {"content": ["line1", "line2", ...], ...}
            if isinstance(file_data, dict) and "content" in file_data:
                content = "\n".join(file_data.get("content", []))
            elif isinstance(file_data, str):
                content = file_data
            else:
                continue

            # Strip /app/ prefix if present
            clean_path = file_path
            if clean_path.startswith("/app/"):
                clean_path = clean_path[5:]
            elif clean_path.startswith("/"):
                clean_path = clean_path[1:]

            # Create full path
            full_path = os.path.join(temp_dir, clean_path)

            # Create parent directories
            parent_dir = os.path.dirname(full_path)
            if parent_dir:
                os.makedirs(parent_dir, exist_ok=True)

            # Write file
            with open(full_path, "w", encoding="utf-8") as f:
                f.write(content)

        # Check if package.json exists
        package_json_path = os.path.join(temp_dir, "package.json")
        if not os.path.exists(package_json_path):
            return {
                "success": False,
                "install_output": "",
                "build_output": "",
                "errors": ["package.json not found. Cannot build without it."],
                "warnings": [],
            }

        # Run npm install
        install_result = subprocess.run(
            ["npm", "install", "--legacy-peer-deps"],
            cwd=temp_dir,
            capture_output=True,
            text=True,
            timeout=120,  # 2 minute timeout for install
        )

        install_output = install_result.stdout + install_result.stderr

        if install_result.returncode != 0:
            return {
                "success": False,
                "install_output": install_output,
                "build_output": "",
                "errors": [f"npm install failed:\n{install_output}"],
                "warnings": [],
            }

        # Run npm run build
        build_result = subprocess.run(
            ["npm", "run", "build"],
            cwd=temp_dir,
            capture_output=True,
            text=True,
            timeout=180,  # 3 minute timeout for build
            env={**os.environ, "CI": "true"},  # Treat warnings as non-fatal
        )

        build_output = build_result.stdout + build_result.stderr

        # Extract errors and warnings
        errors = []
        warnings = []

        for line in build_output.split("\n"):
            line_lower = line.lower()
            if "error" in line_lower and ("ts(" in line or "typescript" in line_lower or "module not found" in line_lower or "cannot find" in line_lower):
                errors.append(line.strip())
            elif "warn" in line_lower:
                warnings.append(line.strip())

        success = build_result.returncode == 0

        return {
            "success": success,
            "install_output": install_output[-2000:] if len(install_output) > 2000 else install_output,
            "build_output": build_output[-5000:] if len(build_output) > 5000 else build_output,
            "errors": errors if not success else [],
            "warnings": warnings[:10],
        }

    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "install_output": "",
            "build_output": "",
            "errors": ["Build timed out. The build process took too long."],
            "warnings": [],
        }
    except FileNotFoundError:
        return {
            "success": False,
            "install_output": "",
            "build_output": "",
            "errors": ["npm not found. Make sure Node.js and npm are installed."],
            "warnings": [],
        }
    except Exception as e:
        return {
            "success": False,
            "install_output": "",
            "build_output": "",
            "errors": [f"Build error: {e!s}"],
            "warnings": [],
        }
    finally:
        # Clean up temp directory
        if temp_dir and os.path.exists(temp_dir):
            try:
                shutil.rmtree(temp_dir)
            except Exception:
                pass  # Ignore cleanup errors


# Create the build_app tool using StructuredTool to get runtime access
build_app = StructuredTool.from_function(
    name="build_app",
    description=BUILD_APP_DESCRIPTION,
    func=_build_app_impl,
)
