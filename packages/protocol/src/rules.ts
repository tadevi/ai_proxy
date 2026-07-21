import type { NormalizedThinking, Rule } from './types.js';

type Json = Record<string, unknown>;
function pathParts(path: unknown) {
  return String(path ?? '')
    .split('.')
    .filter(Boolean);
}
function get(obj: Json, path: unknown): unknown {
  let current: unknown = obj;
  for (const part of pathParts(path)) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Json)[part];
  }
  return current;
}
function set(obj: Json, path: unknown, value: unknown) {
  const parts = pathParts(path);
  if (!parts.length) return;
  let current = obj;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    current = next && typeof next === 'object' ? (next as Json) : ((current[part] = {}) as Json);
  }
  current[parts.at(-1)!] = value;
}
function remove(obj: Json, path: unknown) {
  const parts = pathParts(path);
  const leaf = parts.pop();
  let current: unknown = obj;
  for (const part of parts)
    current = current && typeof current === 'object' ? (current as Json)[part] : undefined;
  if (leaf && current && typeof current === 'object') delete (current as Json)[leaf];
}
function conditionMatches(body: Json, condition: unknown, thinking: NormalizedThinking) {
  if (!condition || typeof condition !== 'object') return true;
  const c = condition as Json;
  if (c.kind === 'thinking_enabled') return thinking.enabled === Boolean(c.value ?? true);
  if (c.kind === 'field_exists') return get(body, c.field) !== undefined;
  if (c.kind === 'field_equals') return get(body, c.field) === c.value;
  return true;
}
export function applyRules(input: Json, rules: Rule[], thinking: NormalizedThinking): Json {
  const body = structuredClone(input);
  for (const rule of [...rules].sort((a, b) => a.position - b.position)) {
    if (!rule.enabled || !conditionMatches(body, rule.config.condition, thinking)) continue;
    const c = rule.config;
    if (rule.type === 'set_field') set(body, c.field, c.value);
    else if (rule.type === 'remove_field') remove(body, c.field);
    else if (rule.type === 'rename_field') {
      const value = get(body, c.from);
      if (value !== undefined) {
        set(body, c.to, value);
        remove(body, c.from);
      }
    } else if (rule.type === 'cap_number') {
      const value = get(body, c.field);
      if (typeof value === 'number' && typeof c.max === 'number')
        set(body, c.field, Math.min(value, c.max));
    } else if (rule.type === 'map_enum') {
      const value = get(body, c.source);
      const mapped =
        c.mapping && typeof c.mapping === 'object' ? (c.mapping as Json)[String(value)] : undefined;
      if (mapped !== undefined) set(body, c.destination, mapped);
    } else if (rule.type === 'thinking_effort') {
      if (!thinking.enabled) {
        if (c.disabledBehavior === 'remove') remove(body, c.destination);
        else if (c.disabledBehavior === 'set') set(body, c.destination, c.disabledValue);
      } else {
        const value =
          c.mapping && typeof c.mapping === 'object'
            ? (c.mapping as Json)[thinking.effort ?? 'medium']
            : thinking.effort;
        if (value !== undefined) set(body, c.destination ?? 'reasoning_effort', value);
      }
    }
  }
  return body;
}
