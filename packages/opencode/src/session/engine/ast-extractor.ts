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
 * 基于 Tree-sitter 的 AST 符号提取器
 */
export class ASTSymbolExtractor {
  private static log = Log.create({ service: "ast.symbol.extractor" });

  /**
   * 提取代码中的核心符号
   * @param parser 已初始化的 Parser 实例
   * @param lang 语言实例 (WASM)
   * @param sourceCode 源代码
   */
  public static async extract(parser: Parser, lang: any, sourceCode: string): Promise<SymbolInfo[]> {
    parser.setLanguage(lang);
    const tree = parser.parse(sourceCode);
    if (!tree) {
      this.log.error("Failed to parse source code");
      return [];
    }
    const symbols: SymbolInfo[] = [];

    // 定义 Tree-sitter 查询语句 (以 TypeScript 为例)
    // 实际生产中应根据不同语言加载不同的 query 配置文件
    const queryStr = `
      (class_declaration name: (type_identifier) @class.name)
      (function_declaration name: (identifier) @function.name)
      (method_definition name: (property_identifier) @method.name)
      (interface_declaration name: (type_identifier) @interface.name)
    `;

    try {
      const query = lang.query(queryStr);
      const matches = query.matches(tree.rootNode);

      for (const match of matches) {
        for (const capture of match.captures) {
          const node = capture.node;
          const type = capture.name.split('.')[0] as SymbolInfo["type"];
          
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
      this.log.error("Query match failed", { error: e });
    }

    return symbols;
  }
}
