import fs from "node:fs";
import path from "node:path";
import {
  optionalBool,
  optionalString,
  requireArray,
  resolveFilePath,
  success,
} from "./utils.js";

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const MAX_FILES = 20;

interface DocSymbol {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "const";
  signature: string;
  jsDoc?: string;
  members?: string[];
}

interface FileDoc {
  file: string;
  symbols: number;
  documentation: string;
}

export function createGenerateAPIDocumentationTool(workspace: string) {
  return {
    schema: {
      name: "generateAPIDocumentation",
      description:
        "Generate markdown or JSON API documentation for TypeScript/JavaScript exported symbols by parsing source files. Extracts functions, classes, interfaces, types, consts, and JSDoc comments.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          files: {
            type: "array",
            items: { type: "string" },
            description: "Relative file paths to document (required)",
          },
          format: {
            type: "string",
            enum: ["markdown", "json"],
            description: "Output format (default: markdown)",
          },
          includePrivate: {
            type: "boolean",
            description: "Include non-exported symbols (default: false)",
          },
        },
        required: ["files"],
        additionalProperties: false as const,
      },
    },
    timeoutMs: 30_000,

    async handler(
      args: Record<string, unknown>,
    ): Promise<ReturnType<typeof success>> {
      const rawFiles = requireArray(args, "files");
      const format = optionalString(args, "format") ?? "markdown";
      const includePrivate = optionalBool(args, "includePrivate") ?? false;

      const filePaths = rawFiles.slice(0, MAX_FILES).map((f) => String(f));

      const docs: FileDoc[] = [];
      let totalSymbols = 0;

      for (const filePath of filePaths) {
        let absPath: string;
        try {
          absPath = resolveFilePath(filePath, workspace);
        } catch {
          docs.push({
            file: filePath,
            symbols: 0,
            documentation: `Error: path "${filePath}" is outside workspace`,
          });
          continue;
        }

        let content: string;
        try {
          const stat = fs.statSync(absPath);
          if (stat.size > MAX_FILE_SIZE) {
            docs.push({
              file: filePath,
              symbols: 0,
              documentation: "Error: file exceeds 1MB limit",
            });
            continue;
          }
          content = fs.readFileSync(absPath, "utf-8");
        } catch (err) {
          docs.push({
            file: filePath,
            symbols: 0,
            documentation: `Error: ${err instanceof Error ? err.message : String(err)}`,
          });
          continue;
        }

        const symbols = extractSymbols(content, includePrivate);
        totalSymbols += symbols.length;

        const documentation =
          format === "json"
            ? JSON.stringify(symbols, null, 2)
            : renderMarkdown(filePath, symbols);

        docs.push({ file: filePath, symbols: symbols.length, documentation });
      }

      return success({ files: docs, totalSymbols });
    },
  };
}

function extractJsDoc(content: string, pos: number): string | undefined {
  // Look backwards from pos for a JSDoc comment
  const before = content.slice(0, pos);
  const match = before.match(/\/\*\*([\s\S]*?)\*\/\s*$/);
  if (!match) return undefined;
  // Clean up the JSDoc text
  return (match[1] ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, "").trim())
    .filter(Boolean)
    .join(" ");
}

function extractSymbols(content: string, includePrivate: boolean): DocSymbol[] {
  const symbols: DocSymbol[] = [];

  // Export prefix pattern
  const exportPrefix = includePrivate ? "(?:export\\s+)?" : "export\\s+";

  // Functions: export function name(...): ReturnType
  const funcRe = new RegExp(
    `${exportPrefix}(?:async\\s+)?function\\s+(\\w+)\\s*(\\([^)]*(?:\\([^)]*\\)[^)]*)*\\))(?:\\s*:\\s*([^{;\\n]+))?`,
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = funcRe.exec(content)) !== null) {
    const name = m[1] ?? "";
    const params = m[2] ?? "()";
    const ret = m[3]?.trim() ?? "";
    const sig = ret
      ? `function ${name}${params}: ${ret}`
      : `function ${name}${params}`;
    symbols.push({
      name,
      kind: "function",
      signature: sig,
      jsDoc: extractJsDoc(content, m.index),
    });
  }

  // Classes: export class Name
  const classRe = new RegExp(
    `${exportPrefix}(?:abstract\\s+)?class\\s+(\\w+)(?:\\s+extends\\s+[\\w<>, ]+)?(?:\\s+implements\\s+[\\w<>, ]+)?`,
    "g",
  );
  while ((m = classRe.exec(content)) !== null) {
    const name = m[1] ?? "";
    const members = extractClassMembers(content, m.index);
    symbols.push({
      name,
      kind: "class",
      signature: `class ${name}`,
      jsDoc: extractJsDoc(content, m.index),
      members,
    });
  }

  // Interfaces: export interface Name
  const ifaceRe = new RegExp(
    `${exportPrefix}interface\\s+(\\w+)(?:\\s+extends\\s+[\\w<>, ]+)?`,
    "g",
  );
  while ((m = ifaceRe.exec(content)) !== null) {
    const name = m[1] ?? "";
    symbols.push({
      name,
      kind: "interface",
      signature: `interface ${name}`,
      jsDoc: extractJsDoc(content, m.index),
    });
  }

  // Types: export type Name = ...
  const typeRe = new RegExp(
    `${exportPrefix}type\\s+(\\w+)(?:<[^>]*>)?\\s*=\\s*([^;\\n]{0,80})`,
    "g",
  );
  while ((m = typeRe.exec(content)) !== null) {
    const name = m[1] ?? "";
    const body = m[2]?.trim() ?? "";
    symbols.push({
      name,
      kind: "type",
      signature: `type ${name} = ${body}`,
      jsDoc: extractJsDoc(content, m.index),
    });
  }

  // Consts: export const name: Type = ...
  const constRe = new RegExp(
    `${exportPrefix}const\\s+(\\w+)(?:\\s*:\\s*([^=\\n]{0,60}))?\\s*=`,
    "g",
  );
  while ((m = constRe.exec(content)) !== null) {
    const name = m[1] ?? "";
    const typeAnnotation = m[2]?.trim();
    const sig = typeAnnotation
      ? `const ${name}: ${typeAnnotation}`
      : `const ${name}`;
    symbols.push({
      name,
      kind: "const",
      signature: sig,
      jsDoc: extractJsDoc(content, m.index),
    });
  }

  return symbols;
}

function extractClassMembers(content: string, classPos: number): string[] {
  // Find the opening brace of the class body
  const after = content.slice(classPos);
  const braceIdx = after.indexOf("{");
  if (braceIdx === -1) return [];

  // Extract up to 2000 chars of class body
  const body = after.slice(braceIdx + 1, braceIdx + 2000);

  const members: string[] = [];
  // constructor
  const ctorMatch = body.match(/constructor\s*(\([^)]*(?:\([^)]*\)[^)]*)*\))/);
  if (ctorMatch) members.push(`constructor${ctorMatch[1] ?? "()"}`);

  // public/protected methods (not private)
  const methodRe =
    /(?:public|protected|static|async|override|\s)+(\w+)\s*(\([^)]*(?:\([^)]*\)[^)]*)*\))(?:\s*:\s*([^{;\n]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = methodRe.exec(body)) !== null) {
    const name = m[1] ?? "";
    if (name === "constructor") continue;
    const params = m[2] ?? "()";
    const ret = m[3]?.trim();
    members.push(ret ? `${name}${params}: ${ret}` : `${name}${params}`);
    if (members.length >= 20) break;
  }
  return members;
}

function renderMarkdown(filePath: string, symbols: DocSymbol[]): string {
  if (symbols.length === 0)
    return `# ${path.basename(filePath)}\n\nNo exported symbols found.\n`;

  const lines: string[] = [`# ${path.basename(filePath)}\n`];

  for (const sym of symbols) {
    lines.push(`## \`${sym.signature}\``);
    if (sym.jsDoc) {
      lines.push(`\n${sym.jsDoc}`);
    }
    if (sym.members && sym.members.length > 0) {
      lines.push("\n**Members:**");
      for (const member of sym.members) {
        lines.push(`- \`${member}\``);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
