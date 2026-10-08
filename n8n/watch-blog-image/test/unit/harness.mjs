// Runs a Code-node body (mode "Run Once for All Items") the way n8n does: top-level `return` and
// `await` allowed, and only n8n's globals in scope ($input, $, console), in a separate vm context
// so accidental use of require/process/Buffer fails like it would in the task runner.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url);

export const readText = rel => readFileSync(new URL(rel, ROOT), 'utf8');

export const clone = v => JSON.parse(JSON.stringify(v));

// Replace a `const NAME = ...;` line, the way a user would edit the node's config block.
export function setConst(code, name, valueSource) {
  const re = new RegExp(`^const ${name} = .*;$`, 'm');
  if (!re.test(code)) throw new Error(`const ${name} not found`);
  return code.replace(re, `const ${name} = ${valueSource};`);
}

/**
 * @param {string} code  Code-node body
 * @param {object} opts
 * @param {Array<{json:any}>} opts.input  items arriving at the node
 * @param {Record<string, Array|{items:Array, itemMatching?: 'throw'|((i:number)=>any), executed?: boolean}>} opts.nodes
 *        data for $('Node name'); a missing name throws like n8n does for unknown nodes, and a node with
 *        `executed: false` throws "Node 'X' hasn't been executed" from all()/first()/last()/itemMatching()
 *        while `.isExecuted` is false (n8n 2.x workflow-data-proxy behaviour)
 * @param {object} [opts.staticData]  backing object for $getWorkflowStaticData('global') (mutated in place,
 *        like n8n's ObservableObject); `staticData.__node` backs $getWorkflowStaticData('node'). When omitted,
 *        $getWorkflowStaticData is not defined, as in a sandbox that lacks it.
 */
export async function runCode(code, { input = [], nodes = {}, staticData } = {}) {
  const $input = {
    all: () => input,
    first: () => input[0],
    last: () => input[input.length - 1],
  };
  const $ = name => {
    if (!Object.hasOwn(nodes, name)) throw new Error(`Referenced node doesn't exist: "${name}"`);
    const spec = nodes[name];
    const items = Array.isArray(spec) ? spec : spec.items;
    const executed = Array.isArray(spec) || spec.executed !== false;
    const ensure = () => { if (!executed) throw new Error(`Node '${name}' hasn't been executed`); };
    return {
      isExecuted: executed,
      all: () => (ensure(), items),
      first: () => (ensure(), items[0]),
      last: () => (ensure(), items[items.length - 1]),
      itemMatching: i => {
        ensure();
        if (spec.itemMatching === 'throw') throw new Error(`Paired item data for item from node '${name}' is unavailable`);
        if (typeof spec.itemMatching === 'function') return spec.itemMatching(i);
        return items[i];
      },
    };
  };
  const globals = { $input, $, console };
  if (staticData !== undefined) {
    globals.$getWorkflowStaticData = type => {
      if (type === 'node') return (staticData.__node ??= {});
      if (type !== 'global') throw new Error('The type needs to either be set to "global" or "node"!');
      return staticData;
    };
  }
  const context = vm.createContext(globals);
  const result = await vm.runInContext(`(async () => {\n${code}\n})()`, context, { filename: 'code-node.js' });
  assertItems(result);
  return clone(result);
}

// n8n rejects Code-node output that is not an array of {json: object} items.
function assertItems(result) {
  if (!Array.isArray(result)) throw new Error('Code node must return an array');
  for (const it of result) {
    if (!it || typeof it !== 'object' || !it.json || typeof it.json !== 'object' || Array.isArray(it.json)) {
      throw new Error('Every returned item needs a json object: ' + JSON.stringify(it).slice(0, 200));
    }
  }
}

export const PREP_CODE = readText('src/prep-post-text.js');
export const BUILD_CODE = readText('src/build-image-queries.js');
export const SPLIT_CODE = readText('src/split-queries.js');
export const PICK_CODE = readText('src/pick-photo.js');
export const PREP_NODE = 'Image: prep post text';
export const BUILD_NODE = 'Image: build queries';
export const SPLIT_NODE = 'Image: split queries';
export const OPENVERSE_NODE = 'Image: search Openverse';
export const COMMONS_NODE = 'Image: search Commons';

export const runPrep = (jsons, code = PREP_CODE) => runCode(code, { input: jsons.map(json => ({ json })) });

/** LLM output items + prep items (or a full node spec) -> build node output. */
export function runBuild(llmJsons, prep, code = BUILD_CODE) {
  const nodes = prep === undefined ? {} : { [PREP_NODE]: Array.isArray(prep) ? prep.map(json => ({ json })) : prep };
  return runCode(code, { input: llmJsons.map(json => ({ json })), nodes });
}

/** Shorthand for a chainLlm success item holding the given watches. */
export const llmText = watches => ({ text: JSON.stringify({ watches }) });
