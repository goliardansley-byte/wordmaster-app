export interface Word {
  id: string;
  english: string;
  chinese: string;
  phase: number;
  learnedCount: number;
  lastStudyDate?: string;
  isCompleted: boolean;
  // SM-2 Fields
  easinessFactor: number;
  interval: number;
  repetition: number;
  nextReviewDate?: number; // timestamp
  // Collection Fields
  rarity: 'Common' | 'Rare' | 'Epic' | 'Legendary';
  isCollected: boolean;
}

export interface UserStats {
  id: string; // 'current'
  tickets: number;
  dailyGoal: number;
  totalCards: number;
}

export interface DailyProgress {
  date: string;
  count: number;
  targetCount: number;
}

export type AppMode = 'home' | 'memorizing' | 'reviewing' | 'cards' | 'gacha';
