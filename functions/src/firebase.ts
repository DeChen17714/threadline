import { initializeApp, getApps, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

let appInstance: App | null = null;
let dbInstance: Firestore | null = null;

export function getDb(): Firestore {
  if (!dbInstance) {
    if (!appInstance) {
      appInstance = getApps()[0] ?? initializeApp();
    }
    dbInstance = getFirestore(appInstance);
  }
  return dbInstance;
}
