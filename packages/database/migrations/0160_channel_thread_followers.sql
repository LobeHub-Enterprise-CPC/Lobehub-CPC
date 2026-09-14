-- Initialize only once: replay must not restore followers the owner has removed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'channel_threads'
      AND column_name = 'follower_member_ids'
  ) THEN
    ALTER TABLE "channel_threads" ADD COLUMN "follower_member_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;

    -- Old broadcast replies are not invitations. Only the root author and human mentions count.
    UPDATE channel_threads AS thread
    SET follower_member_ids = (
      SELECT COALESCE(jsonb_agg(member.id ORDER BY member.id), '[]'::jsonb)
      FROM channel_members AS member
      WHERE member.channel_id = thread.channel_id AND member.active
        AND (
          member.id = (
            SELECT root.author_member_id FROM channel_messages AS root
            WHERE root.id = thread.root_message_id AND root.channel_id = thread.channel_id
          )
          OR EXISTS (
            SELECT 1 FROM channel_messages AS message
            WHERE message.channel_id = thread.channel_id AND message.author_member_id IS NULL
              AND (message.id = thread.root_message_id OR message.thread_id = thread.id)
              AND message.mentions ? member.id
          )
        )
    );
  END IF;
END $$;
