import { getConnection } from "@/modules/database/connection.js";
import { runMigrations } from "@/modules/database/migrations.js";
import { appConfigDb } from "@/modules/database/repositories/app-config.js";
import { userDb } from "@/modules/database/repositories/users.js";
import { INIT_SCHEMA_SQL } from "@/modules/database/schema.js";

// Initialize database with schema
export const initializeDatabase = async () => {
    try {
        const db = getConnection();
        db.exec(INIT_SCHEMA_SQL);
        console.log('Database schema applied');
        runMigrations(db);

        // Seeded once: an install that already has a user (from the old
        // mandatory setup flow) keeps that behavior forever ('account'); a
        // genuinely fresh install starts open ('none') until someone opts
        // into a shared password from Settings. Must run after the schema
        // above (users table needs to exist), which is why this lives here
        // rather than at auth module load time.
        if (appConfigDb.get('auth_mode') === null) {
            appConfigDb.set('auth_mode', userDb.hasUsers() ? 'account' : 'none');
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log('Database initialization failed', { error: message });
        throw err;
    }
};
