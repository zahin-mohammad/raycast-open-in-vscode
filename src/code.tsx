import {
  ActionPanel,
  List,
  getPreferenceValues,
  Detail,
  Action,
  Cache,
  closeMainWindow,
  Icon,
} from "@raycast/api";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { useEffect, useState, useCallback, useRef } from "react";
import { execFile } from "child_process";
import { promisify } from "util";

const execFilePromise = promisify(execFile);

// =============================================================================
// Types
// =============================================================================

type FileDataType = {
  name: string;
  path: string;
  fullPath: string;
  isRoot: boolean;
  isPackage: boolean;
};

type PreferencesType = {
  startDirectory: string;
  maxLevels: string;
  projectHints: string;
  rootProjectHints: string;
  packageHints: string;
  showMonorepoRoot: boolean;
  codeAppName: string;
};

interface ScanContext {
  signal: AbortSignal;
  scanId: string;
  projectCount: number;
  startTime: number;
  maxLevels: number;
  rootHints: Set<string>;
  packageHints: Set<string>;
  legacyHints: Set<string>;
  showMonorepoRoot: boolean;
}

interface CacheEntry {
  projects: FileDataType[];
  timestamp: number;
  version: number;
}

// =============================================================================
// Constants
// =============================================================================

const CACHE_VERSION = 2;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const HARD_LIMITS = {
  MAX_PROJECTS: 200,
  MAX_SCAN_TIME_MS: 15000, // 15 seconds
  MAX_DEPTH: 5,
  MAX_DIRS_PER_LEVEL: 50,
} as const;

// Directories to always skip - these are never useful to scan
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "target",
  ".vscode",
  ".idea",
  "__pycache__",
  ".pytest_cache",
  "venv",
  "env",
  ".env",
  "coverage",
  ".nyc_output",
  "logs",
  "tmp",
  "temp",
  ".cache",
  ".DS_Store",
  ".Trash",
  "Library",
  ".npm",
  ".yarn",
  ".pnpm",
  "vendor",
  "Pods",
  ".gradle",
  ".m2",
  "bin",
  "obj",
]);

// System paths that should never be scanned
const BLOCKED_PATHS = [
  "/Library",
  "/System",
  "/Applications",
  "/private",
  "/.Trash",
  "/Pictures",
  "/Movies",
  "/Music",
  "/Desktop",
  "/Downloads",
  "/Documents",
];

const cache = new Cache();

// =============================================================================
// Utility Functions
// =============================================================================

function parseHints(hintsString: string): Set<string> {
  return new Set(
    hintsString
      .split(",")
      .map((hint) => hint.trim())
      .filter((hint) => hint.length > 0)
  );
}

function getCacheKey(path: string): string {
  return `projects_v${CACHE_VERSION}_${path}`;
}

function getCachedProjects(path: string): FileDataType[] | null {
  const key = getCacheKey(path);
  const raw = cache.get(key);
  if (!raw) return null;

  try {
    const entry: CacheEntry = JSON.parse(raw);
    if (entry.version !== CACHE_VERSION) {
      cache.remove(key);
      return null;
    }
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
      cache.remove(key);
      return null;
    }
    return entry.projects;
  } catch {
    cache.remove(key);
    return null;
  }
}

function setCachedProjects(path: string, projects: FileDataType[]): void {
  const key = getCacheKey(path);
  const entry: CacheEntry = {
    projects,
    timestamp: Date.now(),
    version: CACHE_VERSION,
  };
  cache.set(key, JSON.stringify(entry));
}

function clearCache(path: string): void {
  cache.remove(getCacheKey(path));
}

function shouldSkipDirectory(name: string, fullPath: string): boolean {
  // Skip known non-project directories
  if (SKIP_DIRECTORIES.has(name)) return true;

  // Skip hidden directories (except we check for .git as a hint, not traverse into it)
  if (name.startsWith(".")) return true;

  // Skip blocked system paths
  const homeDir = homedir();
  for (const blocked of BLOCKED_PATHS) {
    if (fullPath.includes(`${homeDir}${blocked}`) || fullPath.startsWith(blocked)) {
      return true;
    }
  }

  return false;
}

function getStartDirectory(): string {
  const { startDirectory = "~/dev" } = getPreferenceValues<PreferencesType>();
  const expanded = startDirectory.replace("~", homedir());
  return resolve(expanded);
}

// =============================================================================
// Async Directory Scanner
// =============================================================================

async function* scanDirectory(
  dirPath: string,
  ctx: ScanContext,
  level: number = 0
): AsyncGenerator<FileDataType> {
  // Check abort signal first
  if (ctx.signal.aborted) return;

  // Check hard limits
  if (ctx.projectCount >= HARD_LIMITS.MAX_PROJECTS) return;
  if (level > Math.min(ctx.maxLevels, HARD_LIMITS.MAX_DEPTH)) return;
  if (Date.now() - ctx.startTime > HARD_LIMITS.MAX_SCAN_TIME_MS) return;

  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    // Can't read directory - skip silently
    return;
  }

  if (ctx.signal.aborted) return;

  // Build sets of what's in this directory for hint checking
  const entryNames = new Set(entries.map((e) => e.name));

  // Check if this directory is a project root (has .git, .gitignore, etc.)
  const isRoot = [...ctx.rootHints].some((hint) => entryNames.has(hint));

  // Check if this directory is a package (has package.json, Cargo.toml, etc.)
  const isPackage = [...ctx.packageHints].some((hint) => entryNames.has(hint));

  // Legacy hint check for backward compatibility
  const isLegacyProject = [...ctx.legacyHints].some((hint) => entryNames.has(hint));

  // Yield this directory as a project if it matches
  const dirName = dirPath.split("/").pop() || dirPath;
  const parentPath = dirPath.substring(0, dirPath.lastIndexOf("/")) || "/";

  if (isRoot && ctx.showMonorepoRoot && ctx.projectCount < HARD_LIMITS.MAX_PROJECTS) {
    ctx.projectCount++;
    yield {
      name: dirName,
      path: parentPath,
      fullPath: dirPath,
      isRoot: true,
      isPackage: false,
    };
  }

  if (isPackage && ctx.projectCount < HARD_LIMITS.MAX_PROJECTS) {
    ctx.projectCount++;
    yield {
      name: dirName,
      path: parentPath,
      fullPath: dirPath,
      isRoot: false,
      isPackage: true,
    };
  }

  // Legacy project (backward compatibility)
  if (isLegacyProject && !isRoot && !isPackage && ctx.projectCount < HARD_LIMITS.MAX_PROJECTS) {
    ctx.projectCount++;
    yield {
      name: dirName,
      path: parentPath,
      fullPath: dirPath,
      isRoot: false,
      isPackage: false,
    };
  }

  // Get subdirectories to scan (filtered and limited)
  const subdirs = entries
    .filter((e) => e.isDirectory())
    .filter((e) => !shouldSkipDirectory(e.name, `${dirPath}/${e.name}`))
    .slice(0, HARD_LIMITS.MAX_DIRS_PER_LEVEL);

  // Recursively scan subdirectories
  for (const subdir of subdirs) {
    if (ctx.signal.aborted) return;
    if (ctx.projectCount >= HARD_LIMITS.MAX_PROJECTS) return;
    if (Date.now() - ctx.startTime > HARD_LIMITS.MAX_SCAN_TIME_MS) return;

    yield* scanDirectory(`${dirPath}/${subdir.name}`, ctx, level + 1);
  }
}

// =============================================================================
// Actions
// =============================================================================

async function openFolderInEditor(appName: string, folderPath: string) {
  try {
    await execFilePromise("open", ["-a", appName, folderPath]);
  } catch (error) {
    console.error("Failed to open folder in editor:", error);
  }
  await closeMainWindow();
}

// =============================================================================
// Components
// =============================================================================

function DirectoryItem(props: {
  fileData: FileDataType;
  onRefresh: () => void;
  startPath: string;
}) {
  const { codeAppName } = getPreferenceValues<PreferencesType>();
  const { fileData, onRefresh, startPath } = props;

  const accessories: { text: string }[] = [];
  if (fileData.isRoot) {
    accessories.push({ text: "Root" });
  }
  if (fileData.isPackage) {
    accessories.push({ text: "Package" });
  }

  return (
    <List.Item
      id={fileData.fullPath}
      title={fileData.name}
      subtitle={fileData.fullPath.replace(startPath, ".")}
      icon={{ fileIcon: fileData.fullPath }}
      accessories={accessories}
      actions={
        <ActionPanel>
          <Action
            onAction={() => openFolderInEditor(codeAppName, fileData.fullPath)}
            title={`Open in ${codeAppName}`}
            icon={Icon.Code}
          />
          <Action.CopyToClipboard
            title="Copy Directory Path"
            content={fileData.fullPath}
            shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
          />
          <Action
            title="Refresh Projects"
            icon={Icon.ArrowClockwise}
            shortcut={{ modifiers: ["cmd"], key: "r" }}
            onAction={onRefresh}
          />
        </ActionPanel>
      }
    />
  );
}

function Directory(props: { path: string }) {
  const { path } = props;
  const homeDir = homedir();

  // Validate path
  if (path === homeDir) {
    return (
      <Detail
        markdown={`# Configuration Error

Cannot scan the entire home directory - this would be too slow and potentially dangerous.

**Please configure a more specific start directory in preferences:**
- \`~/dev\`
- \`~/workspace\`
- \`~/projects\`

Go to Raycast Settings → Extensions → Open in Editor → Start Directory`}
      />
    );
  }

  const [projects, setProjects] = useState<FileDataType[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanStatus, setScanStatus] = useState<string>("Initializing...");
  const abortControllerRef = useRef<AbortController | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleRefresh = useCallback(() => {
    clearCache(path);
    setRefreshKey((k) => k + 1);
  }, [path]);

  useEffect(() => {
    // Cancel any previous scan
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // Check cache first
    const cached = getCachedProjects(path);
    if (cached && cached.length > 0) {
      setProjects(cached);
      setIsLoading(false);
      setError(null);
      setScanStatus("");
      return;
    }

    // Start fresh scan
    setIsLoading(true);
    setError(null);
    setProjects([]);
    setScanStatus("Starting scan...");

    const preferences = getPreferenceValues<PreferencesType>();

    const ctx: ScanContext = {
      signal: abortController.signal,
      scanId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      projectCount: 0,
      startTime: Date.now(),
      maxLevels: Math.min(Number(preferences.maxLevels) || 2, HARD_LIMITS.MAX_DEPTH),
      rootHints: parseHints(preferences.rootProjectHints || ".git, .gitignore, .hg"),
      packageHints: parseHints(
        preferences.packageHints ||
          "package.json, Cargo.toml, go.mod, requirements.txt, pom.xml, build.gradle"
      ),
      legacyHints: parseHints(
        preferences.projectHints || "node_modules, package.json, requirements.txt, .gitignore"
      ),
      showMonorepoRoot: preferences.showMonorepoRoot !== false,
    };

    (async () => {
      try {
        // Verify directory exists
        try {
          await fs.access(path);
        } catch {
          if (!abortController.signal.aborted) {
            setError(`Directory does not exist: ${path}`);
            setIsLoading(false);
          }
          return;
        }

        const results: FileDataType[] = [];
        let lastUpdateCount = 0;

        for await (const project of scanDirectory(path, ctx, 0)) {
          if (abortController.signal.aborted) break;

          results.push(project);

          // Update UI progressively (every 3 projects or first one)
          if (results.length === 1 || results.length - lastUpdateCount >= 3) {
            lastUpdateCount = results.length;
            setProjects([...results]);
            setScanStatus(`Found ${results.length} project${results.length === 1 ? "" : "s"}...`);
          }
        }

        if (!abortController.signal.aborted) {
          setProjects(results);
          setCachedProjects(path, results);
          setIsLoading(false);
          setScanStatus("");
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          const message = err instanceof Error ? err.message : "Unknown error occurred";
          setError(message);
          setIsLoading(false);
        }
      }
    })();

    return () => {
      abortController.abort();
    };
  }, [path, refreshKey]);

  // Error state
  if (error) {
    return (
      <Detail
        markdown={`# Scan Error

**Error:** ${error}

## Troubleshooting

1. **Check the directory exists** - Verify the path in preferences is correct
2. **Check permissions** - Make sure you have read access to the directory
3. **Try a more specific path** - If scanning a large directory, try a subdirectory

## Current Configuration

- **Start Directory:** \`${path}\`
- **Actual Path:** \`${path}\``}
        actions={
          <ActionPanel>
            <Action
              title="Retry Scan"
              icon={Icon.ArrowClockwise}
              onAction={handleRefresh}
            />
          </ActionPanel>
        }
      />
    );
  }

  // Group projects by type
  const rootProjects = projects.filter((p) => p.isRoot);
  const packages = projects.filter((p) => p.isPackage);
  const otherProjects = projects.filter((p) => !p.isRoot && !p.isPackage);

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder={`Search projects in ${path}`}
    >
      {isLoading && projects.length === 0 && (
        <List.EmptyView
          title="Scanning for projects..."
          description={scanStatus}
          icon={Icon.MagnifyingGlass}
        />
      )}

      {!isLoading && projects.length === 0 && (
        <List.EmptyView
          title="No projects found"
          description={`No projects were found in ${path}. Try adjusting your project hints in preferences.`}
          icon={Icon.Folder}
          actions={
            <ActionPanel>
              <Action
                title="Refresh"
                icon={Icon.ArrowClockwise}
                onAction={handleRefresh}
              />
            </ActionPanel>
          }
        />
      )}

      {rootProjects.length > 0 && (
        <List.Section title="Monorepo Roots" subtitle={`${rootProjects.length}`}>
          {rootProjects.map((data) => (
            <DirectoryItem
              fileData={data}
              key={data.fullPath}
              onRefresh={handleRefresh}
              startPath={path}
            />
          ))}
        </List.Section>
      )}

      {packages.length > 0 && (
        <List.Section title="Packages" subtitle={`${packages.length}`}>
          {packages.map((data) => (
            <DirectoryItem
              fileData={data}
              key={data.fullPath}
              onRefresh={handleRefresh}
              startPath={path}
            />
          ))}
        </List.Section>
      )}

      {otherProjects.length > 0 && (
        <List.Section title="Projects" subtitle={`${otherProjects.length}`}>
          {otherProjects.map((data) => (
            <DirectoryItem
              fileData={data}
              key={data.fullPath}
              onRefresh={handleRefresh}
              startPath={path}
            />
          ))}
        </List.Section>
      )}
    </List>
  );
}

export default function Command() {
  return <Directory path={getStartDirectory()} />;
}
