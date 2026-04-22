import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { 
  BookOpen, RotateCcw, PartyPopper, X, Plus, Camera, Loader2, 
  Search, Trophy, Dices, Sparkles, Library, Layers, Trash2, 
  CheckCircle2, AlertCircle, Info, ExternalLink, Scan, Check, ChevronRight
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI } from "@google/genai";
import { Word, DailyProgress, AppMode, UserStats } from './types';
import { db } from './db';
import debounce from 'lodash.debounce';

// --- Types & Constants ---
const ai = process.env.GEMINI_API_KEY ? new (GoogleGenAI as any)(process.env.GEMINI_API_KEY) : null;

// SM-2 Algorithm helper
function calculateSM2(quality: number, word: Word): Partial<Word> {
  let { easinessFactor, interval, repetition } = word;

  // quality: 0-5 (0=Forgot, 3=Hard, 4=Good, 5=Easy)
  if (quality >= 3) {
    if (repetition === 0) {
      interval = 1;
    } else if (repetition === 1) {
      interval = 6;
    } else {
      interval = Math.round(interval * easinessFactor);
    }
    repetition++;
  } else {
    repetition = 0;
    interval = 1;
  }

  // EF calculation
  easinessFactor = easinessFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  if (easinessFactor < 1.3) easinessFactor = 1.3;

  const nextReviewDate = Date.now() + interval * 24 * 60 * 60 * 1000;

  return { easinessFactor, interval, repetition, nextReviewDate };
}

// --- Sub-components (defined above to solve lint issues) ---

const NavItem: React.FC<{ active: boolean; label: string; onClick: () => void }> = ({ active, label, onClick }) => (
  <button 
    onClick={onClick} 
    className={`text-sm font-bold uppercase tracking-widest transition-all px-4 py-2 rounded-full ${active ? 'bg-black text-white' : 'text-[#8E8E8E] hover:text-black hover:bg-gray-100'}`}
  >
    {label}
  </button>
);

const StatBox: React.FC<{ label: string; value: string | number }> = ({ label, value }) => (
  <div className="bg-white p-5 rounded-3xl border border-[#F0F0F0] shadow-sm">
    <span className="text-[10px] font-black text-[#8E8E8E] uppercase block mb-1">{label}</span>
    <span className="text-2xl font-black tracking-tight">{value}</span>
  </div>
);

const WordCard = ({ word }: { word: Word }) => {
  const isCollected = word.isCollected;
  
  const rarityColors = {
    Common: "border-gray-200 bg-white text-gray-800",
    Rare: "border-blue-200 bg-blue-50 text-blue-700",
    Epic: "border-purple-200 bg-purple-50 text-purple-700",
    Legendary: "border-yellow-300 bg-yellow-50 text-yellow-800 shadow-yellow-200/50 shadow-lg"
  };

  return (
    <motion.div 
      whileHover={{ y: -5, scale: 1.02 }}
      className={`aspect-[3/4] rounded-[32px] border-2 p-6 flex flex-col items-center justify-center text-center transition-all relative overflow-hidden ${isCollected ? rarityColors[word.rarity] : 'bg-gray-100 border-dashed border-gray-300 text-gray-400'}`}
    >
      {!isCollected && <div className="absolute inset-0 bg-white/40 backdrop-blur-[4px] z-10" />}
      
      <div className="z-20">
        <h4 className={`text-2xl font-black leading-tight mb-2 ${!isCollected && 'grayscale opacity-50'}`}>
          {word.english}
        </h4>
        {isCollected ? (
          <p className="text-sm font-bold opacity-80 italic border-t border-current pt-2 mt-2">
            {word.chinese}
          </p>
        ) : (
          <div className="flex gap-1 justify-center mt-2">
            {[1, 2, 3].map(i => <div key={i} className="w-1.5 h-1.5 rounded-full bg-current opacity-30" />)}
          </div>
        )}
      </div>

      <div className={`absolute bottom-4 left-0 right-0 text-[10px] font-black uppercase tracking-[0.2em] transition-opacity ${isCollected ? 'opacity-40' : 'opacity-20'}`}>
        {word.rarity}
      </div>

      {isCollected && word.rarity === 'Legendary' && (
        <motion.div 
          animate={{ opacity: [0.3, 0.6, 0.3], scale: [1, 1.1, 1] }}
          transition={{ duration: 3, repeat: Infinity }}
          className="absolute -top-4 -right-4"
        >
          <Sparkles className="text-yellow-500/20" size={80} />
        </motion.div>
      )}
    </motion.div>
  );
};

// --- Main App Component ---

export default function App() {
  // State
  const [words, setWords] = useState<Word[]>([]);
  const [userStats, setUserStats] = useState<UserStats>({ id: 'current', tickets: 0, dailyGoal: 50, totalCards: 0 });
  const [mode, setMode] = useState<AppMode>('home');
  const [studyList, setStudyList] = useState<Word[]>([]);
  const [currentWordIndex, setCurrentWordIndex] = useState(0);
  const [studyPhase, setStudyPhase] = useState<1 | 2 | 3>(1);
  const [dailyProgress, setDailyProgress] = useState<DailyProgress>({ 
    date: new Date().toLocaleDateString(), 
    count: 0, 
    targetCount: 50 
  });
  
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoaded, setIsLoaded] = useState(false);
  const [showCelebration, setShowCelebration] = useState(false);
  
  // Gacha & Scan states
  const [gachaResult, setGachaResult] = useState<Word[] | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scannedWords, setScannedWords] = useState<Array<{english: string, chinese: string}>>([]);
  const [showScanModal, setShowScanModal] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  // --- Effects ---

  useEffect(() => {
    const init = async () => {
      const allWords = await db.words.toArray();
      let stats = await db.userStats.get('current');
      
      if (!stats) {
        stats = { id: 'current', tickets: 5, dailyGoal: 50, totalCards: 0 };
        await db.userStats.add(stats);
      }

      setWords(allWords);
      setUserStats(stats);

      const savedProgress = localStorage.getItem('vocab_progress');
      if (savedProgress) {
        const parsed = JSON.parse(savedProgress);
        if (parsed.date === new Date().toLocaleDateString()) {
          setDailyProgress(parsed);
        } else {
          setDailyProgress({ date: new Date().toLocaleDateString(), count: 0, targetCount: 50 });
        }
      }
      setIsLoaded(true);
    };
    init();
  }, []);

  useEffect(() => {
    if (isLoaded) {
      localStorage.setItem('vocab_progress', JSON.stringify(dailyProgress));
    }
  }, [dailyProgress, isLoaded]);

  useEffect(() => {
    if (isLoaded) {
      db.userStats.put(userStats);
    }
  }, [userStats, isLoaded]);

  // --- Handlers ---

  const awardTicket = useCallback(() => {
    setUserStats(prev => ({ ...prev, tickets: prev.tickets + 1 }));
  }, []);

  const startStudy = async (studyMode: 'memorizing' | 'reviewing') => {
    const now = Date.now();
    let list: Word[] = [];

    if (studyMode === 'memorizing') {
      // Priority: New words (no SM-2 data yet)
      list = words.filter(w => !w.nextReviewDate).slice(0, 20);
    } else {
      // Priority: SM-2 Due today
      list = words.filter(w => w.nextReviewDate && w.nextReviewDate <= now).slice(0, 30);
      if (list.length === 0) {
        // Fallback: Just review some random learned ones
        list = words.filter(w => w.isCompleted).sort(() => Math.random() - 0.5).slice(0, 10);
      }
    }

    if (list.length === 0) {
      alert(studyMode === 'memorizing' ? '目前没有未学习的新词，快去导入一些吧！' : '目前没有待复习的词。');
      return;
    }

    setStudyList(list);
    setCurrentWordIndex(0);
    setStudyPhase(1);
    setMode(studyMode);
  };

  const nextWord = async (quality?: number) => {
    const word = studyList[currentWordIndex];
    let updatedWord = { ...word };

    // Apply SM-2 if quality provided (end of cycle)
    if (quality !== undefined) {
      const sm2Update = calculateSM2(quality, word);
      updatedWord = { 
        ...word, 
        ...sm2Update, 
        isCompleted: true, 
        lastStudyDate: new Date().toISOString() 
      };
      
      await db.words.update(word.id, updatedWord);
      setWords(prev => prev.map(w => w.id === word.id ? updatedWord : w));
    }

    if (currentWordIndex === studyList.length - 1) {
      // Completed current session
      setDailyProgress(prev => {
        const newCount = prev.count + studyList.length;
        if (newCount >= prev.targetCount && prev.count < prev.targetCount) {
          setShowCelebration(true);
          awardTicket();
        }
        return { ...prev, count: newCount };
      });
      setMode('home');
    } else {
      setCurrentWordIndex(prev => prev + 1);
      setStudyPhase(1);
    }
  };

  const handleStudyInteraction = (action: 'correct' | 'wrong' | 'vague' | number) => {
    // Phase 1: Multiple Choice (0=wrong, 1=correct)
    if (studyPhase === 1) {
      if (action === 'correct' || action === 1) setStudyPhase(2);
      else alert('再试一次！');
    }
    // Phase 2: Recall English
    else if (studyPhase === 2) {
      if (action === 'correct') setStudyPhase(3);
      else if (action === 'vague') setStudyPhase(3); // or show hint
      else { setStudyPhase(1); } // Restart cycle for this word
    }
    // Phase 3: Recall Chinese (Mastery Rating)
    else if (studyPhase === 3) {
      if (typeof action === 'number') {
        nextWord(action);
      }
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const data = evt.target?.result;
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json<any>(sheet, { header: 1 });

        const newWords: Word[] = jsonData.slice(1).map((row, i) => {
          const rarityVal = Math.random();
          const rarity = rarityVal > 0.98 ? 'Legendary' : rarityVal > 0.9 ? 'Epic' : rarityVal > 0.7 ? 'Rare' : 'Common';
          
          return {
            id: `word-${Date.now()}-${i}`,
            english: String(row[0] || '').trim(),
            chinese: String(row[1] || '').trim(),
            phase: 1,
            learnedCount: 0,
            isCompleted: false,
            easinessFactor: 2.5,
            interval: 0,
            repetition: 0,
            rarity: rarity as Word['rarity'],
            isCollected: false
          };
        }).filter(w => w.english && w.chinese);

        if (newWords.length > 0) {
          await db.words.bulkAdd(newWords);
          setWords(prev => [...prev, ...newWords]);
          alert(`成功导入 ${newWords.length} 个单词！`);
        }
      } catch (err) {
        console.error(err);
        alert('解析失败，请检查文件格式是否正确。');
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const handleCameraScan = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !ai) return;

    setIsScanning(true);
    setShowScanModal(true);

    try {
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve) => {
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });
      const base64 = await base64Promise;
      const base64Data = base64.split(',')[1];

      const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
      const prompt = "Identify all the English words in this image and provide their standard Chinese translations. Output only as a JSON array: [{\"english\": \"word\", \"chinese\": \"translation\"}]";
      
      const result = await model.generateContent([
        prompt,
        { inlineData: { data: base64Data, mimeType: file.type } }
      ]);
      
      const text = result.response.text();
      const cleanJson = text.replace(/```json|```/g, "").trim();
      const items = JSON.parse(cleanJson);
      setScannedWords(items);
    } catch (err) {
      console.error(err);
      alert('识别失败，请重试。');
    } finally {
      setIsScanning(false);
    }
  };

  const commitScannedWords = async () => {
    const newItems: Word[] = scannedWords.map((item, i) => {
      const rarityVal = Math.random();
      const rarity = rarityVal > 0.98 ? 'Legendary' : rarityVal > 0.9 ? 'Epic' : rarityVal > 0.7 ? 'Rare' : 'Common';
      return {
        id: `scan-${Date.now()}-${i}`,
        english: item.english,
        chinese: item.chinese,
        phase: 1,
        learnedCount: 0,
        isCompleted: false,
        easinessFactor: 2.5,
        interval: 0,
        repetition: 0,
        rarity: rarity as Word['rarity'],
        isCollected: false
      };
    });

    await db.words.bulkAdd(newItems);
    setWords(prev => [...prev, ...newItems]);
    setShowScanModal(false);
    setScannedWords([]);
    alert(`成功添加 ${newItems.length} 个单词！`);
  };

  const drawCard = (count: number) => {
    if (userStats.tickets < count) {
      alert('抽卡券不足哦！多背单词获取吧。');
      return;
    }

    setIsDrawing(true);
    setUserStats(prev => ({ ...prev, tickets: prev.tickets - count }));

    // Simulate "loading the altar"
    setTimeout(async () => {
      const uncollected = words.filter(w => !w.isCollected);
      if (uncollected.length === 0) {
        alert('博学者！你已经集齐了所有卡牌！');
        setIsDrawing(false);
        return;
      }

      const results: Word[] = [];
      for (let i = 0; i < count; i++) {
        const remaining = words.filter(w => !results.find(r => r.id === w.id) && !w.isCollected);
        if (remaining.length > 0) {
          results.push(remaining[Math.floor(Math.random() * remaining.length)]);
        }
      }

      setGachaResult(results);
      setIsDrawing(false);

      // Save to DB
      const ids = results.map(r => r.id);
      await db.words.where('id').anyOf(ids).modify({ isCollected: true });
      setWords(prev => prev.map(w => ids.includes(w.id) ? { ...w, isCollected: true } : w));
    }, 1200);
  };

  const debouncedSearch = useMemo(() => debounce((q: string) => setSearchQuery(q), 300), []);

  if (!isLoaded) return null;

  const currentWord = studyList[currentWordIndex];

  return (
    <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A] font-sans">
      {/* --- Navigation --- */}
      <nav className="fixed top-0 w-full z-40 bg-white/70 backdrop-blur-xl border-b border-gray-100 px-6 py-4">
        <div className="max-w-6xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-10">
            <h1 
              className="text-2xl font-black italic tracking-tighter cursor-pointer flex items-center gap-2" 
              onClick={() => setMode('home')}
            >
              <div className="w-8 h-8 bg-black rounded-lg flex items-center justify-center text-white not-italic">W</div>
              WordsMaster
            </h1>
            <div className="hidden md:flex gap-2">
              <NavItem active={mode === 'home'} label="首页" onClick={() => setMode('home')} />
              <NavItem active={mode === 'cards'} label="图鉴" onClick={() => setMode('cards')} />
              <NavItem active={mode === 'gacha'} label="召唤" onClick={() => setMode('gacha')} />
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="bg-orange-100 text-orange-600 px-4 py-2 rounded-2xl flex items-center gap-2 text-xs font-black shadow-sm">
              <Trophy size={14}/>
              <span>{userStats.tickets} 券</span>
            </div>
            <button 
              onClick={() => fileInputRef.current?.click()} 
              className="p-2.5 bg-black text-white rounded-xl hover:scale-110 active:scale-95 transition-all shadow-lg"
            >
              <Plus size={20}/>
            </button>
            <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden" />
          </div>
        </div>
      </nav>

      {/* --- Main Content --- */}
      <main className="pt-28 pb-12 px-6 max-w-6xl mx-auto min-h-screen">
        <AnimatePresence mode="wait">
          
          {/* HOME MODE */}
          {mode === 'home' && (
            <motion.div key="home" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -15 }} className="space-y-8">
              
              {/* Daily Progress Card */}
              <section className="bg-white rounded-[40px] p-8 md:p-12 shadow-xl shadow-gray-200/50 border border-white flex flex-col md:flex-row items-center gap-12">
                <div className="relative w-48 h-48 flex items-center justify-center">
                  <svg className="w-full h-full -rotate-90">
                    <circle cx="96" cy="96" r="80" stroke="#F1F3F5" strokeWidth="12" fill="transparent" />
                    <motion.circle 
                      cx="96" cy="96" r="80" stroke="#FF5A5F" strokeWidth="12" fill="transparent"
                      strokeDasharray={2 * Math.PI * 80}
                      initial={{ strokeDashoffset: 2 * Math.PI * 80 }}
                      animate={{ strokeDashoffset: (2 * Math.PI * 80) * (1 - Math.min(dailyProgress.count / dailyProgress.targetCount, 1)) }}
                      transition={{ duration: 1.5, ease: "easeOut" }}
                      strokeLinecap="round"
                    />
                  </svg>
                  <div className="absolute flex flex-col items-center">
                    <span className="text-5xl font-black tracking-tighter">{dailyProgress.count}</span>
                    <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Today</span>
                  </div>
                </div>
                <div className="flex-1 space-y-8 w-full">
                  <div>
                    <h2 className="text-4xl font-black italic tracking-tighter mb-2">SM-2 智能神经训练</h2>
                    <p className="text-gray-500 font-medium max-w-md">依据遗忘曲线动态调节复习间隔，让记忆永久驻留。目标：每日 {dailyProgress.targetCount} 词。</p>
                  </div>
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    <StatBox label="词库总量" value={words.length} />
                    <StatBox label="已掌握" value={words.filter(w => w.isCompleted).length} />
                    <StatBox label="待复习" value={words.filter(w => w.nextReviewDate && w.nextReviewDate <= Date.now()).length} />
                    <StatBox label="收藏进度" value={`${Math.round((words.filter(w => w.isCollected).length / (words.length || 1)) * 100)}%`} />
                  </div>
                </div>
              </section>

              {/* Primary Actions */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <motion.button 
                  whileHover={{ y: -8, scale: 1.01 }} whileTap={{ scale: 0.98 }}
                  onClick={() => startStudy('memorizing')}
                  className="bg-[#4D96FF] text-white p-10 rounded-[48px] h-80 flex flex-col justify-between text-left shadow-2xl shadow-blue-500/20 group relative overflow-hidden"
                >
                  <BookOpen size={56} className="relative z-10" />
                  <div className="relative z-10">
                    <h3 className="text-4xl font-black mb-2 italic tracking-tighter uppercase underline decoration-white/30 decoration-8 underline-offset-8">背诵新词</h3>
                    <p className="text-blue-100/70 font-bold uppercase tracking-[0.2em] text-xs">Genesis Memory</p>
                  </div>
                  <Sparkles className="absolute -top-10 -right-10 text-white/10 opacity-0 group-hover:opacity-100 transition-opacity" size={200} />
                </motion.button>
                
                <motion.button 
                  whileHover={{ y: -8, scale: 1.01 }} whileTap={{ scale: 0.98 }}
                  onClick={() => startStudy('reviewing')}
                  className="bg-[#212529] text-white p-10 rounded-[48px] h-80 flex flex-col justify-between text-left shadow-2xl shadow-black/20 group relative overflow-hidden"
                >
                  <RotateCcw size={56} className="relative z-10" />
                  <div className="relative z-10">
                    <h3 className="text-4xl font-black mb-2 italic tracking-tighter uppercase underline decoration-white/10 decoration-8 underline-offset-8">科学复习</h3>
                    <p className="text-gray-500 font-bold uppercase tracking-[0.2em] text-xs">Neural Refresh</p>
                  </div>
                  <Layers className="absolute -bottom-10 -left-10 text-white/5 opacity-0 group-hover:opacity-100 transition-opacity" size={200} />
                </motion.button>
              </div>

              {/* Utility Grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
                <button 
                  onClick={() => cameraInputRef.current?.click()}
                  className="bg-white border border-gray-100 p-8 rounded-[40px] flex flex-col items-center justify-center gap-4 hover:border-black hover:shadow-xl transition-all group"
                >
                  <Camera className="text-gray-400 group-hover:text-black transition-colors" size={32} />
                  <span className="font-black text-sm italic">拍照识词</span>
                  <input type="file" accept="image/*" capture="environment" ref={cameraInputRef} onChange={handleCameraScan} className="hidden" />
                </button>
                <button 
                  onClick={() => setMode('cards')}
                  className="bg-white border border-gray-100 p-8 rounded-[40px] flex flex-col items-center justify-center gap-4 hover:border-black hover:shadow-xl transition-all group"
                >
                  <Library className="text-gray-400 group-hover:text-black transition-colors" size={32} />
                  <span className="font-black text-sm italic">卡牌图鉴</span>
                </button>
                <button 
                  onClick={() => setMode('gacha')}
                  className="bg-white border border-gray-100 p-8 rounded-[40px] flex flex-col items-center justify-center gap-4 hover:border-black hover:shadow-xl transition-all group"
                >
                  <Dices className="text-gray-400 group-hover:text-black transition-colors" size={32} />
                  <span className="font-black text-sm italic">欧气召唤</span>
                </button>
                <button 
                  onClick={async () => { if(confirm('确定清空词库吗？')) { await db.words.clear(); setWords([]); } }}
                  className="bg-white border border-gray-100 p-8 rounded-[40px] flex flex-col items-center justify-center gap-4 hover:border-red-500 hover:text-red-500 hover:shadow-xl transition-all group"
                >
                  <Trash2 className="text-gray-300 group-hover:text-red-500 transition-colors" size={32} />
                  <span className="font-black text-sm italic">重置系统</span>
                </button>
              </div>

              {/* Search Section */}
              <div className="max-w-xl mx-auto w-full relative">
                <Search className="absolute left-6 top-1/2 -translate-y-1/2 text-gray-400" size={24} />
                <input 
                  type="text" 
                  placeholder="搜索你的词库..." 
                  onChange={(e) => debouncedSearch(e.target.value)}
                  className="w-full bg-white border border-gray-100 pl-16 pr-8 py-6 rounded-[32px] font-bold text-lg focus:ring-4 focus:ring-gray-100 outline-none transition-all shadow-sm"
                />
              </div>

              {searchQuery && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 p-4">
                  {words.filter(w => w.english.toLowerCase().includes(searchQuery.toLowerCase())).slice(0, 9).map(w => (
                    <motion.div 
                      key={w.id} 
                      className="bg-white p-6 rounded-3xl border border-gray-50 flex items-center justify-between shadow-sm hover:shadow-md transition-all group"
                    >
                      <div className="flex flex-col">
                        <span className="text-xl font-black tracking-tight">{w.english}</span>
                        <span className="text-sm font-bold text-gray-400 italic">{w.chinese}</span>
                      </div>
                      <a 
                        href={`https://dict.youdao.com/w/${w.english}`} 
                        target="_blank" 
                        rel="noreferrer"
                        className="p-2 text-gray-300 group-hover:text-black transition-colors"
                      >
                        <ExternalLink size={18} />
                      </a>
                    </motion.div>
                  ))}
                </div>
              )}
            </motion.div>
          )}

          {/* STUDY MODE (3 PHASES) */}
          {(mode === 'memorizing' || mode === 'reviewing') && currentWord && (
            <motion.div key="study" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="max-w-2xl mx-auto flex flex-col items-center">
              {/* Progress Bar */}
              <div className="w-full mb-16 space-y-4">
                <div className="flex justify-between items-end">
                   <div className="flex items-center gap-2">
                     <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">Step {currentWordIndex + 1} / {studyList.length}</span>
                     <div className={`px-2 py-0.5 rounded-md text-[8px] font-black border ${currentWord.rarity === 'Legendary' ? 'border-yellow-400 text-yellow-600 bg-yellow-50' : 'border-gray-200 text-gray-400'}`}>
                       {currentWord.rarity}
                     </div>
                   </div>
                   <div className="flex gap-1">
                     {[1, 2, 3].map(p => (
                       <div key={p} className={`w-1.5 h-1.5 rounded-full ${studyPhase >= p ? 'bg-black' : 'bg-gray-200'}`} />
                     ))}
                   </div>
                </div>
                <div className="w-full bg-white h-2 rounded-full overflow-hidden border border-gray-100">
                  <motion.div 
                    initial={{ width: 0 }} 
                    animate={{ width: `${((currentWordIndex + 1) / studyList.length) * 100}%` }}
                    className="h-full bg-black shadow-[0_0_10px_rgba(0,0,0,0.1)]"
                  />
                </div>
              </div>

              <div className="min-h-[400px] flex flex-col items-center justify-center p-8 w-full text-center">
                <AnimatePresence mode="wait">
                  
                  {/* PHASE 1: RECOGNITION (Multiple Choice Style - Simulation) */}
                  {studyPhase === 1 && (
                    <motion.div key="p1" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.1 }} className="space-y-12 w-full">
                      <div className="space-y-4">
                        <span className="text-xs font-black uppercase tracking-[0.4em] text-gray-400">Phase I: Recognition</span>
                        <h3 className="text-8xl font-black italic tracking-tighter leading-none">{currentWord.english}</h3>
                      </div>
                      
                      <div className="grid grid-cols-1 gap-4 w-full">
                        <button 
                          onClick={() => handleStudyInteraction('correct')}
                          className="w-full py-8 bg-white border border-gray-100 rounded-[32px] text-2xl font-black italic shadow-sm hover:border-black hover:shadow-xl transition-all"
                        >
                          {currentWord.chinese}
                        </button>
                        <button className="w-full py-8 bg-white border border-gray-50 rounded-[32px] text-lg font-bold text-gray-300 opacity-50 cursor-not-allowed">
                          (干扰选项 A)
                        </button>
                        <div className="flex justify-center pt-8">
                          <button onClick={() => setStudyPhase(2)} className="text-gray-400 underline font-bold uppercase tracking-widest text-[10px]">跳过练习</button>
                        </div>
                      </div>
                    </motion.div>
                  )}

                  {/* PHASE 2: PRODUCTION/RECALL (Recall English) */}
                  {studyPhase === 2 && (
                    <motion.div key="p2" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.1 }} className="space-y-12 w-full">
                      <div className="space-y-4">
                        <span className="text-xs font-black uppercase tracking-[0.4em] text-gray-400">Phase II: Recall English</span>
                        <h3 className="text-6xl font-black italic tracking-tighter leading-none">{currentWord.chinese}</h3>
                      </div>
                      
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full">
                        <button 
                          onClick={() => handleStudyInteraction('wrong')}
                          className="py-10 bg-gray-50 text-gray-400 rounded-[40px] font-black uppercase tracking-tighter hover:bg-red-50 hover:text-red-500 transition-all border border-transparent"
                        >
                          忘记了
                        </button>
                        <button 
                          onClick={() => handleStudyInteraction('vague')}
                          className="py-10 bg-gray-50 text-gray-400 rounded-[40px] font-black uppercase tracking-tighter hover:bg-orange-50 hover:text-orange-500 transition-all border border-transparent"
                        >
                          模糊
                        </button>
                        <button 
                          onClick={() => handleStudyInteraction('correct')}
                          className="py-10 bg-black text-white rounded-[40px] font-black uppercase tracking-tighter shadow-xl hover:scale-105 transition-all"
                        >
                          记住了
                        </button>
                      </div>
                    </motion.div>
                  )}

                  {/* PHASE 3: MASTERY (Recall Chinese & SM-2 Rating) */}
                  {studyPhase === 3 && (
                    <motion.div key="p3" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.1 }} className="space-y-12 w-full">
                      <div className="space-y-4">
                        <span className="text-xs font-black uppercase tracking-[0.4em] text-gray-400">Phase III: Semantic Mastery</span>
                        <h3 className="text-8xl font-black italic tracking-tighter leading-none">{currentWord.english}</h3>
                      </div>
                      
                      <div className="bg-gray-50 p-10 rounded-[40px] border border-gray-100 flex flex-col items-center">
                        <span className="text-[10px] font-black uppercase text-gray-400 mb-4 italic">Interpretation</span>
                        <p className="text-4xl font-black">{currentWord.chinese}</p>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 w-full pt-8">
                        <div className="flex flex-col gap-2">
                           <button onClick={() => handleStudyInteraction(0)} className="py-6 bg-red-100 text-red-600 rounded-[24px] font-black uppercase tracking-tighter hover:scale-105 transition-all">Forgot (0)</button>
                           <span className="text-[8px] font-black text-gray-400">再次重来</span>
                        </div>
                        <div className="flex flex-col gap-2">
                           <button onClick={() => handleStudyInteraction(3)} className="py-6 bg-orange-100 text-orange-600 rounded-[24px] font-black uppercase tracking-tighter hover:scale-105 transition-all">Hard (3)</button>
                           <span className="text-[8px] font-black text-gray-400">勉强记住</span>
                        </div>
                        <div className="flex flex-col gap-2">
                           <button onClick={() => handleStudyInteraction(4)} className="py-6 bg-blue-100 text-blue-600 rounded-[24px] font-black uppercase tracking-tighter hover:scale-105 transition-all">Good (4)</button>
                           <span className="text-[8px] font-black text-gray-400">基本掌握</span>
                        </div>
                        <div className="flex flex-col gap-2">
                           <button onClick={() => handleStudyInteraction(5)} className="py-6 bg-green-100 text-green-600 rounded-[24px] font-black uppercase tracking-tighter hover:scale-105 transition-all">Easy (5)</button>
                           <span className="text-[8px] font-black text-gray-400">完美通关</span>
                        </div>
                      </div>
                    </motion.div>
                  )}

                </AnimatePresence>
              </div>

              <div className="mt-12 flex gap-4">
                 <button onClick={() => setMode('home')} className="p-4 bg-white border border-gray-100 rounded-full hover:bg-gray-50 transition-colors shadow-sm"><Trash2 size={20}/></button>
                 <a 
                   href={`https://dict.youdao.com/w/${currentWord.english}`} 
                   target="_blank" 
                   rel="noreferrer"
                   className="flex items-center gap-2 px-6 py-4 bg-white border border-gray-100 rounded-full font-black text-[10px] uppercase tracking-widest hover:border-black transition-all shadow-sm"
                 >
                   <ExternalLink size={14} /> Youdao Dictionary
                 </a>
              </div>
            </motion.div>
          )}

          {/* GALLERY MODE */}
          {mode === 'cards' && (
            <motion.div key="cards" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-12">
              <div className="flex flex-col md:flex-row justify-between items-end gap-4">
                <div className="space-y-2">
                  <h3 className="text-6xl font-black italic tracking-tighter uppercase underline decoration-black/5 decoration-8 underline-offset-8">博学者殿堂</h3>
                  <p className="text-gray-400 font-bold uppercase tracking-widest text-xs">The Hall of Curated Vocabulary</p>
                </div>
                <div className="bg-black text-white px-8 py-3 rounded-2xl flex items-center gap-4">
                  <span className="text-xs font-black uppercase opacity-60">进度</span>
                  <span className="text-3xl font-black italic">{words.filter(w=>w.isCollected).length} / {words.length}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-8">
                {words.map((w, idx) => (
                  <WordCard key={w.id || idx} word={w} />
                ))}
              </div>
            </motion.div>
          )}

          {/* GACHA MODE */}
          {mode === 'gacha' && (
            <motion.div key="gacha" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="max-w-3xl mx-auto flex flex-col items-center space-y-16 py-12">
              <div className="text-center space-y-6">
                 <motion.div 
                   animate={{ rotate: [0, 10, -10, 0] }}
                   transition={{ duration: 4, repeat: Infinity }}
                   className="w-24 h-24 bg-red-50 text-red-500 rounded-3xl flex items-center justify-center mx-auto shadow-xl"
                 >
                   <Dices size={48} />
                 </motion.div>
                 <h3 className="text-7xl font-black italic tracking-tighter">真理祭坛</h3>
                 <p className="text-gray-400 font-bold tracking-[0.4em] text-xs uppercase">Summon Transcendent Knowledge</p>
              </div>

              <div className="flex flex-col md:flex-row gap-8 w-full">
                <button 
                  onClick={() => drawCard(1)} 
                  disabled={isDrawing}
                  className="flex-1 p-12 bg-white border border-gray-100 rounded-[56px] flex flex-col items-center gap-6 hover:border-black hover:shadow-2xl transition-all group disabled:opacity-50"
                >
                  <span className="text-6xl font-black italic">x1</span>
                  <div className="flex flex-col items-center gap-1 group-hover:scale-110 transition-transform">
                    <span className="text-[10px] font-black uppercase text-gray-400 group-hover:text-black">单次召唤</span>
                    <span className="text-[9px] font-black text-orange-500 font-mono">1 召唤券</span>
                  </div>
                </button>
                <button 
                  onClick={() => drawCard(5)} 
                  disabled={isDrawing}
                  className="flex-1 p-12 bg-black text-white rounded-[56px] flex flex-col items-center gap-6 hover:shadow-[0_20px_50px_rgba(0,0,0,0.3)] hover:scale-105 transition-all group disabled:opacity-50 relative overflow-hidden"
                >
                  <Sparkles className="absolute top-4 right-4 text-white/10" size={80} />
                  <span className="text-6xl font-black italic text-yellow-400">x5</span>
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-[10px] font-black uppercase text-gray-500">五连神授</span>
                    <span className="text-[9px] font-black text-yellow-500 font-mono">5 召唤券</span>
                  </div>
                </button>
              </div>

              {isDrawing && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-6">
                  <Loader2 className="animate-spin text-black" size={40} />
                  <p className="font-black italic tracking-widest text-gray-400 animate-pulse uppercase text-xs">正在连接灵界...</p>
                </motion.div>
              )}

              {gachaResult && (
                <motion.div initial={{ opacity: 0, y: 50 }} animate={{ opacity: 1, y: 0 }} className="w-full space-y-10">
                   <div className="flex justify-between items-center px-4">
                     <span className="text-xl font-black italic tracking-tighter">神启降临：</span>
                     <button onClick={() => setGachaResult(null)} className="p-2 hover:bg-gray-100 rounded-full"><X/></button>
                   </div>
                   <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                     {gachaResult.map((r, i) => (
                       <motion.div 
                         key={i}
                         initial={{ rotateY: 90, scale: 0.5 }}
                         animate={{ rotateY: 0, scale: 1 }}
                         transition={{ delay: i * 0.1, type: "spring" }}
                       >
                         <WordCard word={r} />
                       </motion.div>
                     ))}
                   </div>
                </motion.div>
              )}
            </motion.div>
          )}

        </AnimatePresence>
      </main>

      {/* --- Modals & Overlays --- */}

      {/* Scan Modal */}
      <AnimatePresence>
        {showScanModal && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md p-6"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 30 }} animate={{ scale: 1, y: 0 }}
              className="bg-white rounded-[48px] p-10 max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col shadow-2xl"
            >
              <div className="flex justify-between items-center mb-8">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-black rounded-2xl flex items-center justify-center text-white"><Scan size={20}/></div>
                  <h3 className="text-3xl font-black italic tracking-tighter">灵能扫描结果</h3>
                </div>
                <button onClick={() => setShowScanModal(false)} className="p-2 hover:bg-gray-100 rounded-full"><X/></button>
              </div>

              {isScanning ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-8 py-20">
                  <div className="relative">
                    <Loader2 className="animate-spin text-black" size={64} />
                    <Scan className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-gray-200" size={24} />
                  </div>
                  <p className="font-black italic tracking-widest text-[#8E8E8E] animate-pulse">正在解析图像中的单词...</p>
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto pr-4 space-y-4">
                  {scannedWords.map((item, i) => (
                    <div key={i} className="flex items-center justify-between p-5 bg-gray-50 rounded-3xl border border-gray-100">
                      <div className="flex flex-col">
                        <span className="text-xl font-black tracking-tight">{item.english}</span>
                        <span className="text-sm font-bold text-gray-400 italic">{item.chinese}</span>
                      </div>
                      <div className="w-8 h-8 bg-black text-white rounded-xl flex items-center justify-center shadow-lg">
                        <Check size={16} />
                      </div>
                    </div>
                  ))}
                  {scannedWords.length === 0 && (
                    <div className="text-center py-20 text-gray-400 font-bold italic">未检测到任何词汇。</div>
                  )}
                </div>
              )}

              {!isScanning && scannedWords.length > 0 && (
                <div className="mt-10">
                  <button 
                    onClick={commitScannedWords}
                    className="w-full py-6 bg-black text-white rounded-[28px] font-black text-xl hover:shadow-2xl hover:scale-[1.02] active:scale-98 transition-all flex items-center justify-center gap-3"
                  >
                    全部存入词库 <ChevronRight size={20}/>
                  </button>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Celebration Modal */}
      <AnimatePresence>
        {showCelebration && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md p-6"
          >
            <motion.div 
               initial={{ scale: 0.8, rotate: -5 }} animate={{ scale: 1, rotate: 0 }}
               className="bg-white rounded-[56px] p-12 max-w-sm w-full text-center shadow-[0_30px_100px_rgba(0,0,0,0.5)] relative"
            >
              <div className="absolute -top-12 left-1/2 -translate-x-1/2 w-24 h-24 bg-[#FF5A5F] text-white rounded-[32px] flex items-center justify-center shadow-2xl rotate-12">
                <PartyPopper size={56} />
              </div>
              <div className="mt-8 space-y-6">
                <h2 className="text-5xl font-black italic tracking-tighter leading-none mb-2">Stage Clear!</h2>
                <div className="bg-orange-50 p-6 rounded-[32px] border border-orange-100">
                  <p className="text-[#8E8E8E] mb-2 text-[10px] font-black uppercase tracking-widest">获得奖励</p>
                  <div className="flex items-center justify-center gap-3 text-orange-600">
                    <Trophy size={32} />
                    <span className="text-4xl font-black italic">+1 召唤券</span>
                  </div>
                </div>
                <p className="text-gray-400 text-sm font-medium">伟大的修行！你距离博学者更近了一步。去祭坛尝试召唤新的远古卡牌吧！</p>
                <button 
                  onClick={() => setShowCelebration(false)} 
                  className="w-full bg-black text-white py-6 rounded-[28px] font-black text-xl hover:shadow-xl active:scale-95 transition-all"
                >
                  继续前行
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}

