import crypto from "node:crypto";

const SCHEMA_ALLOW = new Set(["type", "description", "properties", "required", "items", "enum"]);

export function dereferenceSchema(schema, defs = {}, visited = new Set()) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map((s) => dereferenceSchema(s, defs, visited));
  if (visited.has(schema)) return schema;
  visited.add(schema);
  const mergedDefs = { ...defs };
  if (schema.$defs && typeof schema.$defs === "object") Object.assign(mergedDefs, schema.$defs);
  if (schema.definitions && typeof schema.definitions === "object") Object.assign(mergedDefs, schema.definitions);
  if (typeof schema.$ref === "string") {
    const key = schema.$ref.replace(/^#\/(\$defs\/|definitions\/)?/, "");
    if (mergedDefs[key]) return dereferenceSchema(mergedDefs[key], mergedDefs, visited);
  }
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "$defs" || k === "definitions") continue;
    out[k] = dereferenceSchema(v, mergedDefs, visited);
  }
  return out;
}

export function normalizeSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(normalizeSchema);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!SCHEMA_ALLOW.has(key)) continue;
    if (key === "type") {
      if (typeof value === "string") out.type = value;
      else if (Array.isArray(value)) {
        const scalar = value.find((v) => typeof v === "string" && v !== "null");
        if (scalar) out.type = scalar;
      }
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const props = {};
      for (const [pName, pSchema] of Object.entries(value)) {
        props[pName] = normalizeSchema(pSchema);
      }
      out.properties = props;
      continue;
    }
    if (key === "enum") {
      if (Array.isArray(value) && value.every((e) => typeof e === "string")) {
        out.enum = value;
      }
      continue;
    }
    if (key === "items") {
      out.items = normalizeSchema(value);
      continue;
    }
    if (key === "required") {
      if (Array.isArray(value) && value.every((e) => typeof e === "string")) {
        out.required = value;
      }
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function ensureRootObject(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  if (!schema.type) {
    return { ...schema, type: "object", properties: schema.properties || {} };
  }
  return schema;
}

export function sanitizeToolParameters(raw) {
  return normalizeSchema(ensureRootObject(dereferenceSchema(raw ?? { type: "object", properties: {} })));
}
