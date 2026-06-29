import fs from 'fs';
import { db } from './src/db';
import { tasks, habits, directives } from './src/db/schema';

async function migrate() {
  try {
    if (fs.existsSync('tasks.json')) {
      const data = fs.readFileSync('tasks.json', 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed) && parsed.length > 0) {
        await db.insert(tasks).values(parsed).onConflictDoNothing();
        console.log(`Migrated ${parsed.length} tasks.`);
      }
    }

    if (fs.existsSync('habits.json')) {
      const data = fs.readFileSync('habits.json', 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed) && parsed.length > 0) {
        await db.insert(habits).values(parsed).onConflictDoNothing();
        console.log(`Migrated ${parsed.length} habits.`);
      }
    }

    if (fs.existsSync('directive.json')) {
      const data = fs.readFileSync('directive.json', 'utf-8');
      const parsed = JSON.parse(data);
      if (typeof parsed === 'string') {
        await db.insert(directives).values({ id: 'default', userId: 'default', directive: parsed }).onConflictDoNothing();
        console.log(`Migrated directive.`);
      }
    }

    console.log("Migration complete.");
  } catch (error) {
    console.error("Migration error:", error);
  } finally {
    process.exit(0);
  }
}

migrate();
