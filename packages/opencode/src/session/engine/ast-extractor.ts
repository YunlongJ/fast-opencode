import { Parser } from "web-tree-sitter";
import { Log } from "@/util/log";

/**
 * 符号元数据接口
 */
export interface SymbolInfo {
  name: string;
  type: "class" | "function" | "method" | "interface" | "variable";
  startLine: number;
  endLine: number;
  content: string;
}

/**
 * 语言特定的 Tree-sitter 查询
 */
const QUERIES: Record<string, string> = {
  typescript: `
    (class_declaration name: (type_identifier) @class.name)
    (function_declaration name: (identifier) @function.name)
    (method_definition name: (property_identifier) @method.name)
    (interface_declaration name: (type_identifier) @interface.name)
    (variable_declarator name: (identifier) @variable.name)
  `,
  javascript: `
    (class_declaration name: (identifier) @class.name)
    (function_declaration name: (identifier) @function.name)
    (method_definition name: (property_identifier) @method.name)
    (variable_declarator name: (identifier) @variable.name)
  `,
  java: `
    (class_declaration name: (identifier) @class.name)
    (method_declaration name: (identifier) @method.name)
    (interface_declaration name: (identifier) @interface.name)
    (field_declaration (variable_declarator name: (identifier) @variable.name))
  `,
  python: `
    (class_definition name: (identifier) @class.name)
    (function_definition name: (identifier) @function.name)
    (assignment left: (identifier) @variable.name)
  `
};

/**
 * 基于 Tree-sitter 的 AST 符号提取器
 */
export class ASTSymbolExtractor {
  private static log = Log.create({ service: "ast.symbol.extractor" });

  /**
   * 提取代码中的核心符号
   * @param parser 已初始化的 Parser 实例
   * @param lang 语言实例 (WASM)
   * @param sourceCode 源代码
   * @param languageId 语言 ID (例如 'typescript', 'java')
   */
  public static async extract(parser: Parser, lang: any, sourceCode: string, languageId: string = "typescript"): Promise<SymbolInfo[]> {
    parser.setLanguage(lang);
    const tree = parser.parse(sourceCode);
    if (!tree) {
      this.log.error("Failed to parse source code");
      return [];
    }
    const symbols: SymbolInfo[] = [];

    // 获取对应语言的查询语句
    const queryStr = QUERIES[languageId] || QUERIES.typescript;

    try {
      const query = lang.query(queryStr);
      const matches = query.matches(tree.rootNode);

      for (const match of matches) {
        for (const capture of match.captures) {
          const node = capture.node;
          const captureName = capture.name;
          const type = captureName.split('.')[0] as SymbolInfo["type"];
          
          // 避免重复索引同一个节点
          const isDuplicate = symbols.some(s => s.name === node.text && s.startLine === node.startPosition.row);
          if (isDuplicate) continue;

          symbols.push({
            name: node.text,
            type: type,
            startLine: node.startPosition.row,
            endLine: node.endPosition.row,
            content: node.parent?.text || node.text // 提取父节点以获取完整定义
          });
        }
      }
    } catch (e) {
      this.log.error("Query match failed", { languageId, error: e });
    }

    return symbols;
  }
}
