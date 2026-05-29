/// <reference path="../pb_data/types.d.ts" />

// Adds a `team_id` text field to the built in `users` auth collection so every
// student account is linked to exactly one team. The platform derives team_id
// from the auth token, never from request bodies.
migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");

    // Avoid adding the field twice if the migration runs again.
    if (!users.fields.getByName("team_id")) {
      users.fields.add(
        new TextField({
          name: "team_id",
          required: false,
          max: 100,
        })
      );
    }

    // Let authenticated users read team membership of others (needed for the
    // team picker on the dashboard). Records remain isolated in the APIs by
    // team_id derived from the token.
    users.listRule = "@request.auth.id != ''";
    users.viewRule = "@request.auth.id != ''";

    app.save(users);
  },
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const field = users.fields.getByName("team_id");
    if (field) {
      users.fields.removeById(field.id);
      app.save(users);
    }
  }
);
