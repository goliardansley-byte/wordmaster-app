import Dexie, { Table } from 'dexie';
import { Word, UserStats } from './types';

export class WordDatabase extends Dexie {
  words!: Table<Word>;
  userStats!: Table<UserStats>;

  constructor() {
    super('WordMasterDB');
    this.version(2).stores({
      words: '++id, english, phase, isCompleted, lastStudyDate, nextReviewDate, isCollected',
      userStats: 'id'
    });
  }
}

export const db = new WordDatabase();
