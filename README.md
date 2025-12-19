# Open in Editor

[Raycast](https://www.raycast.com) extension that recursively scans your dev folder for projects and opens them in your preferred editor. Now with enhanced monorepo support!

## Features

- **Monorepo Support**: Detects both monorepo roots and individual packages
- **Smart Caching**: Prevents race conditions and improves performance
- **Configurable Detection**: Separate hints for root projects and packages
- **Visual Indicators**: Clear distinction between root projects and packages
- **Multiple Editor Support**: Works with VS Code, Cursor, and other editors

## Settings

### Basic Settings
- `startDirectory`: Starting directory for the command. ~ is expanded into your home directory.
  - default: `~/dev`
- `maxLevels`: Number of levels of folders to recursively scan for projects. Maximum of 5.
  - default: `2`
- `codeAppName`: The name of the application to open the project with.
  - default: `Cursor`

### Monorepo Settings
- `rootProjectHints`: Files/folders that indicate a project root (like monorepo root). Search continues for packages within.
  - default: `.git, .gitignore, .hg`
- `packageHints`: Files that indicate individual packages or subprojects within a monorepo.
  - default: `package.json, Cargo.toml, go.mod, requirements.txt, pom.xml, build.gradle`
- `showMonorepoRoot`: Include monorepo root directories in the results along with individual packages.
  - default: `true`

### Legacy Settings
- `projectHints`: Legacy setting for backward compatibility. Use 'Root Project Hints' and 'Package Hints' for better monorepo support.
  - default: `node_modules, package.json, requirements.txt, .gitignore`

## How It Works

The extension now intelligently handles monorepos by:

1. **Root Detection**: Identifies monorepo roots using hints like `.git`, `.gitignore`
2. **Package Discovery**: Continues searching within roots for individual packages
3. **Smart Display**: Groups results into "Monorepo Roots", "Packages", and "Other Projects"
4. **Visual Indicators**: Shows 📁 for roots and 📦 for packages

This means you can now open both the entire monorepo and individual packages within it!
