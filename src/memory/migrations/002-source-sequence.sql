-- 清除最后一条消息也不能重用游标，否则新消息会落在已处理游标之前。
CREATE TABLE memory_sequence(name TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT INTO memory_sequence VALUES('source', (SELECT coalesce(max(source_order),0) FROM message_event));
