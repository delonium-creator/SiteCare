PRAGMA foreign_keys = ON;

-- The connection panel showed only a generic "личный чат"/"группа" label
-- for a linked Telegram destination -- no way to tell WHOSE personal chat
-- or WHICH group without opening Telegram itself. The webhook that links
-- the destination already receives the sender's name (private chats) or
-- the chat's title (groups) in the same update; this column lets us keep
-- it instead of discarding it. Existing rows stay NULL and the API falls
-- back to the old generic label for them.
ALTER TABLE telegram_destinations ADD COLUMN chat_name TEXT;
