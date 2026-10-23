-- 超长原文分批整理，只有完整消费才推进消息序号；偏移按 UTF-16 字符位置记录。
ALTER TABLE memory_cursor ADD COLUMN source_offset INTEGER NOT NULL DEFAULT 0;
