import assert from 'node:assert/strict';
import { detectMemoryContextCapabilities, validateMemorySummary } from '../src/memory/context.js';
assert.equal(detectMemoryContextCapabilities({version:'unknown'}).qqBackend,false);
assert.equal(detectMemoryContextCapabilities({summaryAdapter:{install(){}}}).visibility,'unknown');
assert.equal(validateMemorySummary({text:'摘要',refs:[{memoryId:'a',revision:1}],truncated:true},[{memoryId:'a',revision:1}]).visibility,'unknown');
assert.equal(validateMemorySummary({text:'摘要',refs:[{memoryId:'a',revision:2}]},[{memoryId:'a',revision:1}]).visibility,'unknown');
assert.equal(validateMemorySummary({text:'摘要',refs:[{memoryId:'a',revision:1}]},[{memoryId:'a',revision:1}]).evidence,false);
console.log('memory compaction: PASS (explicit fallback, invalid/truncated summary remains unknown)');
