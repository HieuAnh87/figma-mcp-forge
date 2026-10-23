// Forge additions: MCP definitions for the authoring tools handled by
// plugin/src/main/forge.ts. Names and parameters follow figma-mcp-go (MIT).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Node } from "./node.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const fileKey = z
  .string()
  .optional()
  .describe("Target file key when several Figma files are connected (see list_files).");
const nodeId = (what = "Node") =>
  z.string().describe(`${what} ID in colon format, e.g. '4029:12345'`);
const nodeIds = z
  .array(z.string())
  .min(1)
  .describe("Node IDs in colon format, e.g. ['4029:12345']");
const hex = z.string().describe("Hex color, e.g. #1f4fd8");

async function call(
  node: Node,
  type: string,
  ids: string[] | undefined,
  params: Record<string, unknown>,
  key: string | undefined,
  render?: (data: any) => string
): Promise<ToolResult> {
  try {
    const resp = await node.sendWithParams(type, ids, params, key);
    if (resp.error) return { content: [{ type: "text", text: resp.error }], isError: true };
    return {
      content: [{ type: "text", text: render ? render(resp.data) : JSON.stringify(resp.data) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    };
  }
}

export function registerForgeTools(server: McpServer, node: Node): void {
  /** Registers a tool whose arguments go to the plugin as params; `nodeIds` travels separately. */
  const tool = (name: string, description: string, shape: z.ZodRawShape) =>
    server.tool(name, description, { ...shape, fileKey }, async (args) => {
      const {
        fileKey: key,
        nodeIds: ids,
        ...params
      } = args as {
        fileKey?: string;
        nodeIds?: string[];
      } & Record<string, unknown>;
      return call(node, name, ids, params, key);
    });

  // --- components --------------------------------------------------------
  tool(
    "create_component",
    "Convert an existing node (usually a FRAME) into a reusable COMPONENT in place.",
    {
      nodeId: nodeId("Node to convert"),
      name: z.string().optional().describe("Component name; defaults to the node's name"),
    }
  );
  tool(
    "create_instance",
    "Create an INSTANCE of a COMPONENT (or the default variant of a COMPONENT_SET), optionally inside a parent and with variant properties.",
    {
      componentId: nodeId("COMPONENT or COMPONENT_SET"),
      parentId: z
        .string()
        .optional()
        .describe("Parent frame/page ID; defaults to the current page"),
      x: z.number().optional(),
      y: z.number().optional(),
      name: z.string().optional(),
      variantProperties: z
        .record(z.union([z.string(), z.boolean()]))
        .optional()
        .describe('Component/variant property values, e.g. {"State": "Hover"}'),
    }
  );
  tool(
    "combine_as_variants",
    "Combine sibling COMPONENT nodes into a COMPONENT_SET (variants). Name components 'Prop=Value' first for proper variant properties.",
    { nodeIds, name: z.string().optional().describe("Component set name") }
  );
  tool(
    "get_local_components",
    "List components and component sets defined in this file (all pages).",
    {
      includeVariants: z
        .boolean()
        .optional()
        .describe("Also list each variant inside component sets (default false)"),
    }
  );
  tool("swap_component", "Swap the main component of an INSTANCE, keeping position and size.", {
    nodeId: nodeId("INSTANCE"),
    componentId: nodeId("Target COMPONENT"),
  });
  tool("detach_instance", "Detach instances into plain frames; visual properties are kept.", {
    nodeIds,
  });

  // --- variables ---------------------------------------------------------
  tool(
    "create_variable_collection",
    "Create a local variable collection. Free plans allow one mode per collection; use name prefixes like 'light/…' and 'dark/…' there.",
    {
      name: z.string(),
      initialModeName: z.string().optional().describe("Rename the first mode (default 'Mode 1')"),
    }
  );
  tool(
    "add_variable_mode",
    "Add a mode (e.g. Dark) to a collection. Fails with 'Limited to 1 modes only' on free plans; do not retry.",
    { collectionId: z.string(), modeName: z.string() }
  );
  tool(
    "create_variable",
    "Create a variable in a collection. Use slash names ('color/accent', 'space/md'). The value sets the default mode.",
    {
      collectionId: z.string(),
      name: z.string(),
      type: z.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"]),
      value: z
        .union([z.string(), z.number(), z.boolean()])
        .optional()
        .describe("COLOR: hex. FLOAT: number. STRING: text. BOOLEAN: true/false."),
      description: z.string().optional(),
    }
  );
  tool(
    "set_variable_value",
    "Set a variable's value for one mode, either a literal value or an alias to another variable.",
    {
      variableId: z.string(),
      modeId: z.string(),
      value: z.union([z.string(), z.number(), z.boolean()]).optional(),
      aliasOf: z.string().optional().describe("Variable ID to alias instead of a literal value"),
    }
  );
  tool(
    "bind_variable_to_node",
    "Bind a variable to a node property. COLOR: fillColor, strokeColor. FLOAT: width, height, opacity, cornerRadius and per-corner radii, strokeWeight, itemSpacing, counterAxisSpacing, padding*, min/max sizes; on TEXT also fontSize, lineHeight, letterSpacing, paragraphSpacing. STRING: characters, fontFamily, fontStyle. BOOLEAN: visible.",
    { nodeId: nodeId(), variableId: z.string(), field: z.string() }
  );
  tool(
    "delete_variable",
    "Delete one variable (variableId) or a whole collection (collectionId). Provide exactly one.",
    {
      variableId: z.string().optional(),
      collectionId: z.string().optional(),
    }
  );
  server.tool(
    "export_tokens",
    "Export local variables (every mode, aliases resolved to var() in CSS) and solid paint styles as JSON or CSS custom properties.",
    { format: z.enum(["json", "css"]).optional(), fileKey },
    async ({ format, fileKey: key }) =>
      call(node, "export_tokens", undefined, { format }, key, (data) =>
        data?.format === "css" ? String(data.css) : JSON.stringify(data?.tokens ?? data, null, 2)
      )
  );

  // --- styles ------------------------------------------------------------
  tool("create_paint_style", "Create a local paint style with one solid color.", {
    name: z.string().describe("e.g. 'Brand/Primary'"),
    color: hex,
    opacity: z.number().min(0).max(1).optional(),
    description: z.string().optional(),
  });
  tool("create_text_style", "Create a local text style. The font must be available to Figma.", {
    name: z.string().describe("e.g. 'Heading/H1'"),
    fontFamily: z.string().optional().describe("Default Inter"),
    fontStyle: z.string().optional().describe("e.g. Regular, Medium, Bold (default Regular)"),
    fontSize: z.number().optional().describe("Default 16"),
    lineHeightValue: z.number().optional(),
    lineHeightUnit: z.enum(["PIXELS", "PERCENT"]).optional(),
    letterSpacingValue: z.number().optional(),
    letterSpacingUnit: z.enum(["PIXELS", "PERCENT"]).optional(),
    textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
    textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE"]).optional(),
    description: z.string().optional(),
  });
  tool(
    "create_effect_style",
    "Create a local effect style: drop/inner shadow or layer/background blur.",
    {
      name: z.string(),
      type: z.enum(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR"]).optional(),
      color: hex.optional(),
      opacity: z.number().min(0).max(1).optional(),
      offsetX: z.number().optional(),
      offsetY: z.number().optional(),
      radius: z.number().optional(),
      spread: z.number().optional(),
      description: z.string().optional(),
    }
  );
  tool("create_grid_style", "Create a local layout grid style (GRID, COLUMNS, or ROWS).", {
    name: z.string(),
    pattern: z.enum(["GRID", "COLUMNS", "ROWS"]).optional(),
    count: z.number().optional(),
    gutterSize: z.number().optional(),
    offset: z.number().optional(),
    sectionSize: z.number().optional(),
    alignment: z.enum(["STRETCH", "CENTER", "MIN", "MAX"]).optional(),
    color: hex.optional(),
    opacity: z.number().optional(),
    description: z.string().optional(),
  });
  tool("update_paint_style", "Update a paint style's name, color, or description.", {
    styleId: z.string(),
    name: z.string().optional(),
    color: hex.optional(),
    opacity: z.number().min(0).max(1).optional(),
    description: z.string().optional(),
  });
  tool("delete_style", "Delete a local style by ID.", { styleId: z.string() });
  tool("apply_style_to_node", "Link a node to a local paint, text, effect, or grid style.", {
    nodeId: nodeId(),
    styleId: z.string(),
    target: z.enum(["fill", "stroke"]).optional().describe("Paint styles only (default fill)"),
  });

  // --- reactions ---------------------------------------------------------
  tool("get_reactions", "Read prototype reactions on a node.", { nodeId: nodeId() });
  tool(
    "set_reactions",
    "Set prototype reactions on a node. Each reaction is {trigger:{type:'ON_CLICK'|…}, actions:[{type:'NODE', destinationId, navigation:'NAVIGATE'|'OVERLAY'|…, transition:{type:'DISSOLVE', duration:0.3, easing:{type:'EASE_OUT'}}, preserveScrollPosition:false} | {type:'BACK'} | {type:'URL', url}]}.",
    {
      nodeId: nodeId(),
      reactions: z.array(z.record(z.unknown())),
      mode: z.enum(["replace", "append"]).optional().describe("Default replace"),
    }
  );
  tool(
    "remove_reactions",
    "Remove reactions by zero-based index, or all when indices is omitted.",
    {
      nodeId: nodeId(),
      indices: z.array(z.number().int().min(0)).optional(),
    }
  );

  // --- layout ------------------------------------------------------------
  tool(
    "set_layout_child",
    "Set how nodes size and position inside their auto-layout parent: layoutSizingHorizontal/Vertical FIXED|HUG|FILL (FILL needs an auto-layout parent; HUG applies to auto-layout frames and text), layoutGrow, layoutAlign, layoutPositioning AUTO|ABSOLUTE, and min/max width/height (null clears).",
    {
      nodeIds,
      layoutSizingHorizontal: z.enum(["FIXED", "HUG", "FILL"]).optional(),
      layoutSizingVertical: z.enum(["FIXED", "HUG", "FILL"]).optional(),
      layoutGrow: z.number().min(0).max(1).optional(),
      layoutAlign: z.enum(["MIN", "CENTER", "MAX", "STRETCH", "INHERIT"]).optional(),
      layoutPositioning: z.enum(["AUTO", "ABSOLUTE"]).optional(),
      minWidth: z.number().nullable().optional(),
      maxWidth: z.number().nullable().optional(),
      minHeight: z.number().nullable().optional(),
      maxHeight: z.number().nullable().optional(),
    }
  );
  tool(
    "set_constraints",
    "Set resize constraints relative to the parent (non-auto-layout parents).",
    {
      nodeIds,
      horizontal: z.enum(["MIN", "MAX", "CENTER", "STRETCH", "SCALE"]).optional(),
      vertical: z.enum(["MIN", "MAX", "CENTER", "STRETCH", "SCALE"]).optional(),
    }
  );
  tool("rotate_nodes", "Rotate nodes to an absolute angle in degrees.", {
    nodeIds,
    rotation: z.number(),
  });
  tool("reorder_nodes", "Change z-order within the parent.", {
    nodeIds,
    order: z.enum(["bringToFront", "sendToBack", "bringForward", "sendBackward"]),
  });
  tool("set_blend_mode", "Set the blend mode of nodes.", {
    nodeIds,
    blendMode: z.enum([
      "PASS_THROUGH",
      "NORMAL",
      "DARKEN",
      "MULTIPLY",
      "LINEAR_BURN",
      "COLOR_BURN",
      "LIGHTEN",
      "SCREEN",
      "LINEAR_DODGE",
      "COLOR_DODGE",
      "OVERLAY",
      "SOFT_LIGHT",
      "HARD_LIGHT",
      "DIFFERENCE",
      "EXCLUSION",
      "HUE",
      "SATURATION",
      "COLOR",
      "LUMINOSITY",
    ]),
  });
  tool("lock_nodes", "Lock nodes against accidental edits.", { nodeIds });
  tool("unlock_nodes", "Unlock nodes.", { nodeIds });

  // --- text and search ---------------------------------------------------
  tool(
    "find_replace_text",
    "Find and replace text in every TEXT node of a subtree (default: current page). Fonts are loaded automatically.",
    {
      find: z.string(),
      replace: z.string(),
      nodeId: z.string().optional(),
      useRegex: z.boolean().optional(),
      regexFlags: z.string().optional().describe("Default 'g'"),
    }
  );
  tool("scan_text_nodes", "List TEXT nodes in a subtree with their content and font.", {
    nodeId: z.string().optional().describe("Default: current page"),
    limit: z.number().int().positive().optional(),
  });
  tool(
    "search_nodes",
    "Find nodes by name substring (case-insensitive) and/or type in a subtree.",
    {
      query: z.string(),
      types: z.array(z.string()).optional(),
      nodeId: z.string().optional().describe("Default: current page"),
      limit: z.number().int().positive().optional().describe("Default 50"),
    }
  );
  tool(
    "scan_nodes_by_types",
    "Find all nodes of the given types in a subtree, regardless of name.",
    {
      types: z.array(z.string()).min(1),
      nodeId: z.string().optional().describe("Default: current page"),
      limit: z.number().int().positive().optional(),
    }
  );
  tool(
    "batch_rename_nodes",
    "Rename nodes with find/replace (optionally regex) and/or a prefix and suffix.",
    {
      nodeIds,
      find: z.string().optional(),
      replace: z.string().optional(),
      useRegex: z.boolean().optional(),
      regexFlags: z.string().optional(),
      prefix: z.string().optional(),
      suffix: z.string().optional(),
    }
  );
  tool("get_fonts", "List fonts used in a subtree (default: current page) by usage count.", {
    nodeId: z.string().optional(),
  });

  // --- pages and view ----------------------------------------------------
  tool("navigate_to_page", "Switch the current page by ID or exact name.", {
    pageId: z.string().optional(),
    pageName: z.string().optional(),
  });
  tool("rename_page", "Rename a page found by ID or exact name.", {
    newName: z.string(),
    pageId: z.string().optional(),
    pageName: z.string().optional(),
  });
  tool("delete_page", "Delete a page by ID or exact name. The last page cannot be deleted.", {
    pageId: z.string().optional(),
    pageName: z.string().optional(),
  });
  tool("get_viewport", "Read the viewport center, zoom, and visible bounds.", {});
  tool("get_annotations", "Read Dev Mode annotations in a subtree (default: current page).", {
    nodeId: z.string().optional(),
  });
}
