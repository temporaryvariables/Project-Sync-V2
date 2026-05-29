# PocketBase (Authentication)

PocketBase handles all authentication, user accounts, and team membership for Project Sync.

## What the migration does

`pb_migrations/1700000000_add_team_id_to_users.js` runs automatically on boot and:

- Adds a `team_id` text field to the built in `users` collection.
- Allows authenticated users to list and view other users (so the dashboard team picker can work).

## First run

1. Start the service (`docker compose up pocketbase` or deploy the folder in Coolify).
2. Open the admin UI at `/_/` and create the first superuser.
3. Register student accounts from the Mission Control login page, or create them here and set their `team_id`.

## How backends validate tokens

Each backend reads the `Authorization: Bearer <token>` header and calls PocketBase's
`/api/collections/users/auth-refresh` endpoint with that token. If it succeeds, the
returned record contains the user's `team_id`, which the backend trusts as the team scope.
Healthchecks are the only endpoints that skip auth.

## Local binary (without Docker)

```bash
# download the matching binary from https://pocketbase.io/docs/
./pocketbase serve --http=0.0.0.0:8090
```

The `pb_migrations` folder is picked up automatically when it sits next to the binary.
