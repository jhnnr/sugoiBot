# Moderation Module

Tools for server moderation including kick, ban, and warnings.

## ⌨️ Slash Commands

### `/ban`

Bans a member from the server.

#### Options

- `target` (Required): The member to ban
- `reason` (Optional): The reason for banning

### `/clear`

Bulk deletes messages from the channel.

#### Options

- `amount` (Required): Number of messages to clear (1-100)

### `/kick`

Kicks a member from the server.

#### Options

- `target` (Required): The member to kick
- `reason` (Optional): The reason for kicking

### `/setlog`

Set the server audit log channel directly in this server.

#### Options

- `channel` (Required): The text channel to send server audit logs to

### `/testlog`

Sends a test audit log message to verify your logging configuration.

### `/warn`

Warns a member and stores it in the database.

#### Options

- `target` (Required): The member to warn
- `reason` (Required): The reason for warning

