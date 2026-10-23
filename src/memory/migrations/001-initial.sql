-- 来源和版本独立保存；当前版本改变不覆盖历史。跨范围关联还必须经服务授权。
CREATE TABLE schema_migration(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
CREATE TABLE memory_scope(id TEXT PRIMARY KEY, owner_bot_id TEXT NOT NULL, conversation_key TEXT NOT NULL,
 generation INTEGER NOT NULL DEFAULT 0, barrier INTEGER NOT NULL DEFAULT 0, policy TEXT NOT NULL DEFAULT '{}',
 revision INTEGER NOT NULL DEFAULT 1, UNIQUE(owner_bot_id,conversation_key));
CREATE TABLE subject(id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES memory_scope(id), qq_id TEXT NOT NULL,
 name TEXT NOT NULL DEFAULT '', UNIQUE(scope_id,qq_id));
CREATE TABLE subject_alias(id INTEGER PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES subject(id), name TEXT NOT NULL,
 first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, UNIQUE(subject_id,name));
CREATE TABLE message_event(id TEXT PRIMARY KEY, source_order INTEGER NOT NULL UNIQUE, scope_id TEXT NOT NULL REFERENCES memory_scope(id),
 platform_message_id TEXT, sender_id TEXT NOT NULL, sender_name TEXT NOT NULL DEFAULT '', occurred_at INTEGER,
 received_at INTEGER NOT NULL, text TEXT NOT NULL, segments TEXT NOT NULL DEFAULT '[]', quote_id TEXT,
 direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')), sent_successfully INTEGER NOT NULL DEFAULT 0,
 UNIQUE(scope_id,platform_message_id));
CREATE INDEX message_scope_order ON message_event(scope_id,source_order);
CREATE TABLE source_record(id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES memory_scope(id),
 kind TEXT NOT NULL CHECK(kind IN ('platform_message','knowledge_revision','admin_assertion','legacy_unverified')),
 target_id TEXT, target_revision INTEGER, actor TEXT, reason TEXT, recorded_at INTEGER NOT NULL);
CREATE TABLE memory_item(id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES memory_scope(id), kind TEXT NOT NULL,
 current_revision INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active', merged_into TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX item_scope ON memory_item(scope_id,status,created_at,id);
CREATE TABLE memory_revision(memory_id TEXT NOT NULL REFERENCES memory_item(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
 title TEXT NOT NULL, body TEXT NOT NULL, subject_ids TEXT NOT NULL DEFAULT '[]', topics TEXT NOT NULL DEFAULT '[]',
 occurred_at INTEGER, valid_from INTEGER, valid_to INTEGER, recorded_at INTEGER NOT NULL, source_nature TEXT NOT NULL,
 reason TEXT NOT NULL DEFAULT '', commitment_status TEXT, policy_version TEXT, PRIMARY KEY(memory_id,revision));
CREATE TABLE memory_evidence(memory_id TEXT NOT NULL, revision INTEGER NOT NULL, source_id TEXT NOT NULL REFERENCES source_record(id),
 stance TEXT NOT NULL DEFAULT 'supports', PRIMARY KEY(memory_id,revision,source_id),
 FOREIGN KEY(memory_id,revision) REFERENCES memory_revision(memory_id,revision) ON DELETE CASCADE);
CREATE INDEX evidence_source ON memory_evidence(source_id);
CREATE TABLE memory_relation(id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES memory_scope(id),
 from_id TEXT NOT NULL REFERENCES memory_item(id) ON DELETE CASCADE, to_id TEXT NOT NULL REFERENCES memory_item(id) ON DELETE CASCADE,
 type TEXT NOT NULL, source_id TEXT REFERENCES source_record(id), inferred INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
 UNIQUE(from_id,to_id,type));
CREATE TABLE memory_view(id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES memory_scope(id), subject_id TEXT,
 kind TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', dependencies TEXT NOT NULL DEFAULT '[]', dirty INTEGER NOT NULL DEFAULT 1, updated_at INTEGER);
CREATE TABLE memory_job(id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES memory_scope(id), type TEXT NOT NULL,
 status TEXT NOT NULL, generation INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL, lease_until INTEGER, input_snapshot TEXT, result TEXT, error TEXT, blocked_reason TEXT,
 request_id TEXT, reservation_id TEXT);
CREATE INDEX jobs_queue ON memory_job(status,created_at);
CREATE TABLE memory_cursor(scope_id TEXT PRIMARY KEY REFERENCES memory_scope(id), last_source_order INTEGER NOT NULL DEFAULT 0,
 last_run_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE memory_outbox(id INTEGER PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES memory_scope(id), generation INTEGER NOT NULL,
 kind TEXT NOT NULL, target_id TEXT NOT NULL, revision INTEGER, status TEXT NOT NULL DEFAULT 'queued');
CREATE TABLE memory_budget_reservation(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, day TEXT NOT NULL, purpose TEXT NOT NULL,
 input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, status TEXT NOT NULL, usage TEXT, created_at INTEGER NOT NULL,
 job_id TEXT REFERENCES memory_job(id));
CREATE INDEX budget_day ON memory_budget_reservation(account_id,day,purpose);
CREATE TABLE memory_idempotency(scope_id TEXT NOT NULL REFERENCES memory_scope(id), operation TEXT NOT NULL, key TEXT NOT NULL,
 request_signature TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(scope_id,operation,key));
CREATE TABLE memory_tombstone(scope_id TEXT NOT NULL REFERENCES memory_scope(id), target_type TEXT NOT NULL, target_id TEXT NOT NULL,
 generation INTEGER NOT NULL, erased_at INTEGER NOT NULL, PRIMARY KEY(scope_id,target_type,target_id));
CREATE TABLE context_checkpoint(session_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES memory_scope(id), epoch INTEGER NOT NULL DEFAULT 1,
 visibility TEXT NOT NULL DEFAULT 'unknown', updated_at INTEGER NOT NULL);
CREATE TABLE context_receipt(session_id TEXT NOT NULL REFERENCES context_checkpoint(session_id) ON DELETE CASCADE, epoch INTEGER NOT NULL,
 memory_id TEXT NOT NULL REFERENCES memory_item(id) ON DELETE CASCADE, revision INTEGER NOT NULL, visibility TEXT NOT NULL,
 PRIMARY KEY(session_id,epoch,memory_id));
CREATE TABLE memory_operation(id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES memory_scope(id), type TEXT NOT NULL,
 status TEXT NOT NULL, generation INTEGER NOT NULL, plan TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL);
CREATE TABLE memory_issue(id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES memory_scope(id), type TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open', revision INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL, reason TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE console_saved_view(id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES memory_scope(id), name TEXT NOT NULL,
 data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE vault_binding(id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES memory_scope(id), path TEXT NOT NULL,
 kind TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT '{}');
CREATE TABLE memory_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, config TEXT NOT NULL);
-- 中文先转为字符 n-gram 再进入 FTS；不用默认英文断词冒充中文检索。
CREATE VIRTUAL TABLE memory_fts USING fts5(memory_id UNINDEXED, scope_id UNINDEXED, terms, tokenize='unicode61');
