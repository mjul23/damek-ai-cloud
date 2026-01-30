#!/usr/bin/env node
// 🤖 SERVEUR AVEC SUPABASE + EPSILON PERSISTANT - FINAL!

const express = require('express');
const fs = require('fs');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

console.log(`\n✅ Serveur avec SUPABASE - PORT ${PORT}\n`);

// 🔑 SUPABASE CONFIG
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ ERREUR: Ajoute SUPABASE_URL et SUPABASE_KEY dans Render!');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log(`✅ Connecté à Supabase`);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const TYPES = ['PION', 'CAVALIER', 'FOU', 'TOUR', 'ROI', 'DAME'];
const LEARNING_RATE = 0.25;
const EPSILON_DECAY = 0.995;  // 🆕 CHANGÉ DE 0.9985 À 0.995 (plus rapide!)
const GAMMA = 0.99;

const MAX_BUFFER = 500;  // 🆕 CHANGÉ DE 2000 À 500 (oublier les vieux coups)
const CLEANUP_INTERVAL = 10;
const MAX_HISTORY = 200;
const HEARTBEAT_INTERVAL = 14 * 60 * 1000;

let trainingStatus = { 
  running: false, 
  episode: 0, 
  totalEpisodes: 0, 
  winRate: 0, 
  states: 0, 
  epsilon: 1.0, 
  startTime: null, 
  history: [],
  replayStats: { replays: 0, avgGain: 0 },
  totalEpisodesSoFar: 0,
  epsilonHistory: [],
  lastHeartbeat: new Date(),
  dbStatus: 'CONNECTING'
};

// ===== FONCTIONS SUPABASE =====

// 🆕 SAUVEGARDER LES TRAJECTOIRES GAGNANTES
async function saveWinningTrajectory(episode, winner, stateHistory, moveHistory) {
  try {
    const movesJson = JSON.stringify(moveHistory);
    const statesJson = JSON.stringify(stateHistory);
    
    const { data, error } = await supabase
      .from('winning_trajectories')
      .insert([{
        episode: episode,
        winner: winner,
        states_count: stateHistory.length,
        moves_json: movesJson,
        states_json: statesJson
      }]);
    
    if (error) {
      console.error(`❌ Erreur save trajectory:`, error.message);
      return false;
    }
    
    console.log(`✅ Trajectoire gagnante sauvegardée: Episode ${episode}`);
    return true;
  } catch (e) {
    console.error(`🚨 Erreur:`, e.message);
    return false;
  }
}
  try {
    const { data, error } = await supabase
      .from('history')
      .select('episode')
      .order('episode', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      console.log(`📂 Aucun episode trouvé - Démarrage à 0`);
      return 0;
    }

    console.log(`✅ Dernier episode: ${data.episode}`);
    return data.episode;
  } catch (e) {
    console.error(`⚠️ Erreur chargement episode:`, e.message);
    return 0;
  }
}

// 🆕 CHARGER L'HISTORIQUE DEPUIS SUPABASE
async function loadHistoryFromSupabase() {
  try {
    console.log(`📂 Chargement de l'historique depuis Supabase...`);
    
    const { data, error } = await supabase
      .from('history')
      .select('*')
      .order('episode', { ascending: true });
    
    if (error) {
      console.error(`❌ Erreur Supabase:`, error.message);
      trainingStatus.dbStatus = `ERROR: ${error.message}`;
      return 0;
    }
    
    if (!data || data.length === 0) {
      console.log(`📂 Supabase vide - Démarrage à zéro`);
      trainingStatus.dbStatus = 'EMPTY - Starting fresh';
      return 0;
    }
    
    console.log(`✅ Chargé ${data.length} parties depuis Supabase!`);
    trainingStatus.history = data.slice(-MAX_HISTORY);
    trainingStatus.totalEpisodesSoFar = data.length;
    trainingStatus.dbStatus = `OK - ${data.length} parties chargées`;
    
    return data.length;
  } catch (e) {
    console.error(`🚨 Erreur critique:`, e.message);
    trainingStatus.dbStatus = `CRITICAL: ${e.message}`;
    return 0;
  }
}

// 🆕 SAUVEGARDER UNE PARTIE DANS SUPABASE
async function savePartyToSupabase(party) {
  try {
    const { data, error } = await supabase
      .from('history')
      .insert([{
        episode: party.episode,
        winner: party.winner,
        ai_score: party.ai_score,
        opp_score: party.opp_score,
        epsilon: parseFloat(party.epsilon),
        ai_states: party.ai_states
      }]);
    
    if (error) {
      console.error(`❌ Erreur save Supabase:`, error.message);
      return false;
    }
    
    return true;
  } catch (e) {
    console.error(`🚨 Erreur save:`, e.message);
    return false;
  }
}

// 🆕 CHARGER LES MODÈLES DEPUIS SUPABASE
async function loadModelsFromSupabase() {
  try {
    const { data, error } = await supabase
      .from('models')
      .select('*')
      .eq('id', 1)
      .single();

    if (error || !data) {
      console.log(`📂 Pas de modèles sauvegardés - Démarrage fresh`);
      return { ai1: null, ai2: null };
    }

    console.log(`✅ Modèles chargés depuis Supabase`);
    return {
      ai1: data.ai1_model,
      ai2: data.ai2_model
    };
  } catch (e) {
    console.error(`⚠️ Erreur chargement modèles:`, e.message);
    return { ai1: null, ai2: null };
  }
}

// 🆕 SAUVEGARDER LES MODÈLES DANS SUPABASE
async function saveModelsToSupabase(ai1, ai2) {
  try {
    const models = {
      ai1_model: ai1.toJSON(),
      ai2_model: ai2.toJSON(),
      timestamp: new Date().toISOString(),
      ai1_states: Object.keys(ai1.qTable).length,
      ai2_states: Object.keys(ai2.qTable).length
    };

    const { data, error } = await supabase
      .from('models')
      .upsert([{
        id: 1,
        ai1_model: models.ai1_model,
        ai2_model: models.ai2_model,
        timestamp: models.timestamp,
        ai1_states: models.ai1_states,
        ai2_states: models.ai2_states
      }]);

    if (error) {
      console.error(`❌ Erreur save modèles:`, error.message);
      return false;
    }

    console.log(`✅ Modèles sauvegardés: AI1=${models.ai1_states} états, AI2=${models.ai2_states} états`);
    return true;
  } catch (e) {
    console.error(`🚨 Erreur save modèles:`, e.message);
    return false;
  }
}

// 🆕 CHARGER EPSILON DEPUIS SUPABASE
async function loadEpsilonFromSupabase() {
  try {
    const { data, error } = await supabase
      .from('models')
      .select('epsilon')
      .eq('id', 1)
      .single();

    if (error || !data) {
      console.log(`📂 Pas d'epsilon sauvegardé - Démarrage à 1.0`);
      return 1.0;
    }

    console.log(`✅ Epsilon chargé depuis Supabase: ${data.epsilon.toFixed(6)}`);
    return data.epsilon || 1.0;
  } catch (e) {
    console.error(`⚠️ Erreur chargement epsilon:`, e.message);
    return 1.0;
  }
}

// 🆕 SAUVEGARDER EPSILON DANS SUPABASE
async function saveEpsilonToSupabase(epsilon) {
  try {
    const { data, error } = await supabase
      .from('models')
      .update({ epsilon: epsilon })
      .eq('id', 1);

    if (error) {
      console.error(`❌ Erreur save epsilon:`, error.message);
      return false;
    }

    return true;
  } catch (e) {
    console.error(`🚨 Erreur save epsilon:`, e.message);
    return false;
  }
}

// Charger l'historique au démarrage (charge aussi totalEpisodesSoFar!)
loadHistoryFromSupabase().then(loaded => {
  console.log(`✅ Initialisation Supabase: ${loaded} parties chargées`);
  console.log(`✅ totalEpisodesSoFar = ${trainingStatus.totalEpisodesSoFar}`);
}).catch(e => {
  console.error(`❌ Erreur initialisation historique:`, e.message);
});

let trainingInProgress = false;

const MOVES = {
  PION: (r, c, p, b) => { const m = []; const [dr, dc] = p === 0 ? [1, 1] : [-1, -1]; if (r + dr >= 0 && r + dr < 8 && c + dc >= 0 && c + dc < 8 && !b[r + dr][c + dc]) { m.push({ to: [r + dr, c + dc], cap: false }); } const caps = p === 0 ? [[1,0],[0,1]] : [[-1,0],[0,-1]]; caps.forEach(([cr, cc]) => { const nr = r + cr, nc = c + cc; if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && b[nr][nc] && b[nr][nc].p !== p) { m.push({ to: [nr, nc], cap: true, target: b[nr][nc] }); } }); return m; },
  CAVALIER: (r, c, p, b) => { const m = []; [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]].forEach(([dr,dc]) => { const nr = r+dr, nc = c+dc; if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) { if (!b[nr][nc]) m.push({ to: [nr, nc], cap: false }); else if (b[nr][nc].p !== p) m.push({ to: [nr, nc], cap: true, target: b[nr][nc] }); } }); return m; },
  FOU: (r, c, p, b) => { const m = []; [[-1,-1],[-1,1],[1,-1],[1,1]].forEach(([dr,dc]) => { for (let i = 1; i <= 8; i++) { const nr = r+dr*i, nc = c+dc*i; if (nr < 0 || nr >= 8 || nc < 0 || nc >= 8) break; if (!b[nr][nc]) m.push({ to: [nr, nc], cap: false }); else { if (b[nr][nc].p !== p) m.push({ to: [nr, nc], cap: true, target: b[nr][nc] }); break; } } }); return m; },
  TOUR: (r, c, p, b) => { const m = []; [[-1,0],[1,0],[0,-1],[0,1]].forEach(([dr,dc]) => { for (let i = 1; i <= 8; i++) { const nr = r+dr*i, nc = c+dc*i; if (nr < 0 || nr >= 8 || nc < 0 || nc >= 8) break; if (!b[nr][nc]) m.push({ to: [nr, nc], cap: false }); else { if (b[nr][nc].p !== p) m.push({ to: [nr, nc], cap: true, target: b[nr][nc] }); break; } } }); return m; },
  ROI: (r, c, p, b) => { const m = []; [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]].forEach(([dr,dc]) => { const nr = r+dr, nc = c+dc; if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) { if (!b[nr][nc]) m.push({ to: [nr, nc], cap: false }); else if (b[nr][nc].p !== p) m.push({ to: [nr, nc], cap: true, target: b[nr][nc] }); } }); return m; },
  DAME: (r, c, p, b) => { const m = []; [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]].forEach(([dr,dc]) => { for (let i = 1; i <= 8; i++) { const nr = r+dr*i, nc = c+dc*i; if (nr < 0 || nr >= 8 || nc < 0 || nc >= 8) break; if (!b[nr][nc]) m.push({ to: [nr, nc], cap: false }); else { if (b[nr][nc].p !== p) m.push({ to: [nr, nc], cap: true, target: b[nr][nc] }); break; } } }); return m; }
};

function createBoard() { const b = []; for (let r = 0; r < 8; r++) { b[r] = []; for (let c = 0; c < 8; c++) b[r][c] = null; } [[0,0],[0,1],[1,0],[0,2],[1,1],[2,0],[0,3],[1,2],[2,1],[3,0]].forEach(([r,c], i) => { b[r][c] = { p: 0, spy: i === 0 }; }); [[7,7],[7,6],[6,7],[7,5],[6,6],[5,7],[7,4],[6,5],[5,6],[4,7]].forEach(([r,c], i) => { b[r][c] = { p: 1, spy: i === 0 }; }); return b; }
function getAllMoves(player, type, board) { const all = []; for (let r = 0; r < 8; r++) { for (let c = 0; c < 8; c++) { if (board[r][c]?.p === player) { MOVES[type](r, c, player, board).forEach(m => all.push({ from: [r, c], ...m })); } } } return all; }
function executeMove(board, from, to) { const newBoard = board.map(row => [...row]); newBoard[to[0]][to[1]] = newBoard[from[0]][from[1]]; const captured = board[to[0]][to[1]]; newBoard[from[0]][from[1]] = null; return { board: newBoard, captured }; }

class DamekAI {
  constructor(player = 0) { this.player = player; this.qTable = {}; this.alpha = LEARNING_RATE; this.gamma = GAMMA; this.epsilon = 1.0; this.experiences = []; this.maxExperiences = MAX_BUFFER; }
  getBoardHash(board) { let hash = ''; for (let r = 0; r < 8; r++) { for (let c = 0; c < 8; c++) { const p = board[r][c]; hash += p ? `${p.p}${p.spy ? 'S' : ''}` : '.'; } } return hash; }
  chooseAction(board, moves) { if (!moves.length) return null; if (Math.random() < this.epsilon) { return moves[Math.floor(Math.random() * moves.length)]; } const state = this.getBoardHash(board); let bestMove = moves[0]; let bestQ = -Infinity; for (let move of moves) { const key = `${state}:${move.from[0]},${move.from[1]},${move.to[0]},${move.to[1]}`; const q = this.qTable[key] || 0; if (q > bestQ) { bestQ = q; bestMove = move; } } return bestMove; }
  learn(stateBefore, move, reward, stateAfter) { const key = `${stateBefore}:${move.from[0]},${move.from[1]},${move.to[0]},${move.to[1]}`; const currentQ = this.qTable[key] || 0; let maxQ = 0; for (let k in this.qTable) { if (k.startsWith(stateAfter + ':')) { maxQ = Math.max(maxQ, this.qTable[k]); } } const newQ = currentQ + this.alpha * (reward + this.gamma * maxQ - currentQ); this.qTable[key] = newQ; this.experiences.push({ stateBefore, move, reward, stateAfter }); if (this.experiences.length > this.maxExperiences) { this.experiences.shift(); } }
  replayLearning(batchSize = 30) { if (this.experiences.length < batchSize) return 0; let totalGain = 0; for (let i = 0; i < batchSize; i++) { const idx = Math.floor(Math.random() * this.experiences.length); const exp = this.experiences[idx]; const key = `${exp.stateBefore}:${exp.move.from[0]},${exp.move.from[1]},${exp.move.to[0]},${exp.move.to[1]}`; const oldQ = this.qTable[key] || 0; let maxQ = 0; for (let k in this.qTable) { if (k.startsWith(exp.stateAfter + ':')) { maxQ = Math.max(maxQ, this.qTable[k]); } } const newQ = oldQ + this.alpha * (exp.reward + this.gamma * maxQ - oldQ); const gain = Math.abs(newQ - oldQ); totalGain += gain; this.qTable[key] = newQ; } return totalGain / batchSize; }
  decayEpsilon() { 
    const oldEps = this.epsilon;
    this.epsilon *= EPSILON_DECAY;
    if (this.epsilon < 0.001) this.epsilon = 0.001;  // 🆕 CHANGÉ DE 0.01 À 0.001
    if (this.epsilon > 1.0) this.epsilon = 1.0;
    console.log(`🔴 DEBUG DECAY: ${oldEps.toFixed(8)} × ${EPSILON_DECAY} = ${this.epsilon.toFixed(8)}`);
  }
  toJSON() { return JSON.stringify(this.qTable); }
  fromJSON(json) { try { this.qTable = JSON.parse(json); } catch (e) { this.qTable = {}; } }
  cleanup() { const threshold = 0.05; const keys = Object.keys(this.qTable); let removed = 0; for (let key of keys) { if (Math.abs(this.qTable[key]) < threshold) { delete this.qTable[key]; removed++; } } return removed; }
}

function playGame(ai1, ai2, timeout = 5000) {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      ai1.decayEpsilon();
      ai2.decayEpsilon();
      resolve({ winner: 0, wins: [0, 0] });
    }, timeout);
    try {
      let board = createBoard(); let turn = 0; let roundNum = 0; let wins = [0, 0];
      while (wins[0] < 3 && wins[1] < 3 && roundNum < 50) { 
        roundNum++; turn = 0;
        while (turn < 100) { 
          const dice = TYPES[Math.floor(Math.random() * 6)]; 
          const ai = turn === 0 ? ai1 : ai2; 
          const moves = getAllMoves(turn, dice, board); 
          if (!moves.length) break; 
          const stateBefore = ai.getBoardHash(board); 
          const move = ai.chooseAction(board, moves); 
          if (!move) break; 
          const result = executeMove(board, move.from, move.to); 
          board = result.board; 
          let reward = 1; 
          if (result.captured) { 
            if (result.captured.spy) { 
              reward = 5000; 
              wins[turn]++; 
              ai.learn(stateBefore, move, reward, ai.getBoardHash(board)); 
              
              // 🆕 DECAY ICI!
              console.log(`🔴 Spy capturé! Decay epsilon`);
              ai1.decayEpsilon();
              ai2.decayEpsilon();
              
              clearTimeout(timeoutId); 
              resolve({ winner: wins[0] >= wins[1] ? 0 : 1, wins }); 
              return; 
            } else { 
              reward = 200; 
            } 
          } 
          const stateAfter = ai.getBoardHash(board); 
          ai.learn(stateBefore, move, reward, stateAfter); 
          turn = 1 - turn; 
        } 
      }
      
      // 🔴 DECAY À LA FIN NORMALE
      console.log(`🔴 Fin de partie normale. Decay epsilon: ${ai1.epsilon.toFixed(6)} → ${(ai1.epsilon * 0.995).toFixed(6)}`);
      ai1.decayEpsilon(); 
      ai2.decayEpsilon();
      console.log(`🔴 Après decay: ${ai1.epsilon.toFixed(6)}`);
      
      clearTimeout(timeoutId); 
      resolve({ winner: wins[0] >= wins[1] ? 0 : 1, wins });
    } catch (e) { 
      console.error('Game error:', e); 
      ai1.decayEpsilon();
      ai2.decayEpsilon();
      clearTimeout(timeoutId); 
      resolve({ winner: 0, wins: [0, 0] }); 
    }
  });
}

let ai1 = new DamekAI(0); 
let ai2 = new DamekAI(1);

// Charger les modèles locaux d'abord
try { 
  if (fs.existsSync('ai1.json')) { 
    ai1.fromJSON(fs.readFileSync('ai1.json', 'utf-8')); 
    console.log(`✅ AI1 local chargé: ${Object.keys(ai1.qTable).length} états`);
  } 
  if (fs.existsSync('ai2.json')) { 
    ai2.fromJSON(fs.readFileSync('ai2.json', 'utf-8')); 
    console.log(`✅ AI2 local chargé: ${Object.keys(ai2.qTable).length} états`);
  } 
} catch (e) { 
  console.error(`⚠️ Erreur chargement local:`, e.message);
}

// Charger les modèles depuis Supabase aussi
loadModelsFromSupabase().then(models => {
  if (models.ai1) {
    ai1.fromJSON(models.ai1);
    console.log(`✅ AI1 Supabase chargé: ${Object.keys(ai1.qTable).length} états`);
  }
  if (models.ai2) {
    ai2.fromJSON(models.ai2);
    console.log(`✅ AI2 Supabase chargé: ${Object.keys(ai2.qTable).length} états`);
  }
}).catch(e => {
  console.error(`⚠️ Erreur chargement Supabase:`, e.message);
});

// Charger epsilon depuis Supabase
loadEpsilonFromSupabase().then(epsilon => {
  ai1.epsilon = epsilon;
  ai2.epsilon = epsilon;
  trainingStatus.epsilon = epsilon;  // 🆕 AJOUTER ICI!
  console.log(`✅ Epsilon chargé: ${epsilon.toFixed(6)}`);
}).catch(e => {
  console.error(`⚠️ Erreur epsilon:`, e.message);
});

function startHeartbeat() {
  setInterval(() => {
    const now = new Date();
    trainingStatus.lastHeartbeat = now;
    console.log(`❤️ Heartbeat à ${now.toLocaleTimeString()} - Serveur en vie!`);
  }, HEARTBEAT_INTERVAL);
  console.log(`⏰ Heartbeat lancé`);
}

app.post('/api/train/start', async (req, res) => {
  const { episodes = 1000 } = req.body;
  if (trainingInProgress) { return res.json({ error: 'Entraînement déjà en cours' }); }
  trainingInProgress = true;
  
  // 🆕 CHARGER LE DERNIER EPISODE DEPUIS SUPABASE
  const lastEpisode = await loadLastEpisodeFromSupabase();
  const startingEpisode = lastEpisode + 1;  // ← Continuer depuis le dernier!
  
  console.log(`🔴 DEBUG TRAIN START: lastEpisode=${lastEpisode}, startingEpisode=${startingEpisode}, totalEpisodesSoFar=${trainingStatus.totalEpisodesSoFar}`);
  
  trainingStatus = { running: true, episode: startingEpisode, totalEpisodes: startingEpisode + episodes - 1, winRate: 0, states: Object.keys(ai1.qTable).length, epsilon: ai1.epsilon, startTime: Date.now(), history: trainingStatus.history, replayStats: { replays: 0, avgGain: 0 }, totalEpisodesSoFar: lastEpisode, epsilonHistory: [], lastHeartbeat: trainingStatus.lastHeartbeat, dbStatus: trainingStatus.dbStatus };
  res.json({ status: 'Entraînement lancé', episodes, startFrom: startingEpisode });

  (async () => {
    try {
      for (let ep = startingEpisode; ep <= trainingStatus.totalEpisodes; ep++) {
        const result = await playGame(ai1, ai2, 5000);
        trainingStatus.episode = ep; 
        trainingStatus.states = Object.keys(ai1.qTable).length; 
        trainingStatus.epsilon = ai1.epsilon;  // 🆕 AJOUTER ICI!
        trainingStatus.epsilonHistory.push({ episode: ep, epsilon: ai1.epsilon });
        
        const newEntry = { episode: ep, winner: result.winner, ai_score: result.wins[0], opp_score: result.wins[1], epsilon: ai1.epsilon.toFixed(6), ai_states: trainingStatus.states };
        trainingStatus.history.push(newEntry);
        if (trainingStatus.history.length > MAX_HISTORY) { trainingStatus.history.shift(); }
        
        await savePartyToSupabase(newEntry);
        
        if (ep % 5 === 0) {
          console.log(`📊 Partie ${ep}: Epsilon=${ai1.epsilon.toFixed(6)}, States=${Object.keys(ai1.qTable).length}`);
        }
        
        const wins = trainingStatus.history.filter(h => h.winner === 0).length; trainingStatus.winRate = (wins / trainingStatus.history.length * 100).toFixed(1);

        if ((ep - startingEpisode) % 20 === 0) {
          const gain1 = ai1.replayLearning(30);
          if (gain1) { trainingStatus.replayStats.replays++; trainingStatus.replayStats.avgGain = gain1; }
        }

        if ((ep - startingEpisode) % Math.max(50, Math.floor(trainingStatus.totalEpisodes - startingEpisode + 1) / 10) === 0) {
          try {
            fs.writeFileSync('ai1.json', ai1.toJSON());
            fs.writeFileSync('ai2.json', ai2.toJSON());
            
            await saveModelsToSupabase(ai1, ai2);
            await saveEpsilonToSupabase(ai1.epsilon);
            
            console.log(`✅ Checkpoint: ${ep}/${trainingStatus.totalEpisodes} | Epsilon: ${ai1.epsilon.toFixed(6)} | States: ${Object.keys(ai1.qTable).length}`);
          } catch (e) { console.error('Save error:', e); }
        }

        if ((ep - startingEpisode) % CLEANUP_INTERVAL === 0) {
          ai1.cleanup(); ai2.cleanup();
          console.log(`💾 Mémoire: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB | Epsilon: ${ai1.epsilon.toFixed(4)}`);
        }

        await new Promise(resolve => setImmediate(resolve));
      }

      try {
        fs.writeFileSync('ai1.json', ai1.toJSON());
        fs.writeFileSync('ai2.json', ai2.toJSON());
        
        await saveModelsToSupabase(ai1, ai2);
        await saveEpsilonToSupabase(ai1.epsilon);
      } catch (e) { console.error('Final save error:', e); }

      trainingStatus.running = false;
      trainingStatus.totalEpisodesSoFar = trainingStatus.totalEpisodesSoFar + (trainingStatus.totalEpisodes - startingEpisode + 1);
      console.log(`✅ Entraînement terminé! Epsilon final: ${ai1.epsilon.toFixed(4)}`);
    } catch (e) { console.error('Training error:', e); trainingStatus.running = false; } finally { trainingInProgress = false; }
  })();
});

app.get('/api/train/status', (req, res) => {
  const elapsed = trainingStatus.startTime ? (Date.now() - trainingStatus.startTime) / 1000 : 0;
  res.json({ ...trainingStatus, elapsed: Math.floor(elapsed), totalHistoryLength: trainingStatus.totalEpisodesSoFar });
});

app.get('/api/train/history', (req, res) => res.json(trainingStatus.history));
app.get('/api/epsilon/history', (req, res) => res.json(trainingStatus.epsilonHistory));

app.get('/api/supabase/count', async (req, res) => {
  try {
    const { count, error } = await supabase
      .from('history')
      .select('*', { count: 'exact', head: true });
    
    if (error) {
      console.error(`❌ Erreur count:`, error.message);
      return res.json({ count: 0 });
    }
    
    console.log(`✅ Total Supabase: ${count} parties`);
    res.json({ count: count || 0 });
  } catch (e) {
    console.error(`🚨 Erreur:`, e.message);
    res.json({ count: 0 });
  }
});

app.get('/api/supabase/count', async (req, res) => {
  try {
    const { count, error } = await supabase
      .from('history')
      .select('*', { count: 'exact', head: true });
    
    if (error) {
      console.error(`❌ Erreur count:`, error.message);
      return res.json({ count: 0 });
    }
    
    console.log(`✅ Total Supabase: ${count} parties`);
    res.json({ count: count || 0 });
  } catch (e) {
    console.error(`🚨 Erreur:`, e.message);
    res.json({ count: 0 });
  }
});

app.get('/api/supabase/history', async (req, res) => {
  try {
    // 🆕 Charger TOUTES les parties - Supabase par défaut limite à 1000
    // Faut utiliser range() pour ignorer la limite
    const { data, error, count } = await supabase
      .from('history')
      .select('*', { count: 'exact' })
      .order('episode', { ascending: true })
      .range(0, 10000);  // 🆕 Charger jusqu'à 10000 lignes!
    
    if (error) {
      console.error(`❌ Erreur fetch history:`, error.message);
      return res.json([]);
    }
    
    console.log(`✅ Supabase history: ${data ? data.length : 0} parties chargées! (count: ${count})`);
    res.json(data || []);
  } catch (e) {
    console.error(`🚨 Erreur:`, e.message);
    res.json([]);
  }
});

app.get('/api/stats', (req, res) => {
  res.json({ ai1_states: Object.keys(ai1.qTable).length, ai2_states: Object.keys(ai2.qTable).length, total_actions: Object.keys(ai1.qTable).length + Object.keys(ai2.qTable).length, epsilon: ai1.epsilon.toFixed(6), training: trainingStatus.running, memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB', port: PORT, replays: trainingStatus.replayStats.replays, replayGain: trainingStatus.replayStats.avgGain.toFixed(6), totalEpisodes: trainingStatus.totalEpisodesSoFar, lastHeartbeat: trainingStatus.lastHeartbeat, dbStatus: trainingStatus.dbStatus, config: { gamma: GAMMA, alpha: LEARNING_RATE, epsilonDecay: EPSILON_DECAY } });
});

app.get('/analyse', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Analyse</title><script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/3.9.1/chart.min.js"></script><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial;background:#1a1a2e;color:#fff;padding:20px}.container{max-width:1200px;margin:0 auto}h1{text-align:center;color:#4cc9f0;margin-bottom:30px}.info-bar{background:#1a3a3a;padding:15px;border-radius:4px;margin:15px 0;border-left:3px solid #77dd77;color:#aaa;font-size:0.9em;text-align:center}.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:15px;margin-bottom:30px}.stat-card{background:#0f3460;padding:20px;border-radius:8px;border:1px solid #4cc9f0;text-align:center}.stat-value{font-size:2.5em;font-weight:bold;color:#4cc9f0}.stat-label{color:#aaa;font-size:0.9em;margin-top:10px}.db-status{background:#0f3460;padding:15px;margin:20px 0;border-radius:8px;border:1px solid #77dd77;color:#77dd77;font-size:0.9em}.charts-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(400px,1fr));gap:20px}.chart-container{background:#0f3460;padding:20px;border-radius:8px;border:1px solid #4cc9f0;height:350px;position:relative}.chart-title{color:#4cc9f0;margin-bottom:15px;font-weight:bold}canvas{max-height:300px}</style></head><body><div class="container"><h1>📊 Analyse Damek</h1><div class="info-bar">✅ AVEC SUPABASE 🗄️ Données PERSISTANTES 100% 📊 Total: <strong id="total">-</strong></div><div id="stats" class="stats-grid"></div><div id="db" class="db-status"></div><div class="charts-grid"><div class="chart-container"><div class="chart-title">Victoires</div><canvas id="c1"></canvas></div><div class="chart-container"><div class="chart-title">États</div><canvas id="c2"></canvas></div><div class="chart-container"><div class="chart-title">Epsilon</div><canvas id="c3"></canvas></div><div class="chart-container"><div class="chart-title">Répartition</div><canvas id="c4"></canvas></div></div></div><script>let charts={};async function load(){try{const s=await fetch('/api/train/status'),st=await s.json(),h=await fetch('/api/supabase/history'),hl=await h.json(),c=await fetch('/api/supabase/count'),ct=await c.json(),a=await fetch('/api/stats'),ap=await a.json();document.getElementById('total').textContent=ct.count||hl.length||0;document.getElementById('stats').innerHTML='<div class="stat-card"><div class="stat-value">'+(hl.length>0?((hl.filter(x=>x.winner===0).length/hl.length*100).toFixed(1)):'0')+'%</div><div class="stat-label">Victoires</div></div><div class="stat-card"><div class="stat-value">'+(hl.length||0)+'</div><div class="stat-label">Parties</div></div><div class="stat-card"><div class="stat-value">'+ap.ai1_states.toLocaleString()+'</div><div class="stat-label">États</div></div><div class="stat-card"><div class="stat-value">'+ap.epsilon+'</div><div class="stat-label">Epsilon</div></div>';document.getElementById('db').textContent='🗄️ Supabase: '+ap.dbStatus;if(!hl||hl.length<1)return;const ep=hl.map(x=>x.episode),v=[],st2=[],p=[];let w=0;hl.forEach(x=>{if(x.winner===0)w++;v.push((w/hl.length*100).toFixed(1));st2.push(x.ai_states);p.push(parseFloat(x.epsilon))});const tw=hl.filter(x=>x.winner===0).length,tl=hl.length-tw;mk('c1',ep,v,'#4cc9f0');mk('c2',ep,st2,'#f72585');const epe=hl.map(x=>x.episode),epv=hl.map(x=>parseFloat(x.epsilon));mk('c3',epe,epv,'#77dd77');mk('c4',[tw,tl],['#4cc9f0','#f72585'],'pie')}catch(e){console.error(e)}}function mk(i,x,y,c,t){const a=document.getElementById(i);if(!a)return;if(charts[i])charts[i].destroy();const ctx=a.getContext('2d');const isp='c4'===i;charts[i]=new Chart(ctx,{type:isp?'doughnut':'line',data:{labels:x,datasets:[{label:t||'',data:y,borderColor:c,backgroundColor:isp?c:'rgba(0,0,0,0.1)',borderWidth:2,fill:!isp,tension:0.3}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#fff'}}},scales:{y:{ticks:{color:'#fff'},grid:{color:'rgba(255,255,255,0.1)'}},x:{ticks:{color:'#fff'},grid:{color:'rgba(255,255,255,0.1)'}}}}});}load();setInterval(load,5000);</script></body></html>`);
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>IA Damek</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial;background:#1a1a2e;color:#fff;padding:20px}.container{max-width:600px;margin:0 auto;background:#0f3460;padding:20px;border-radius:8px;border:1px solid #4cc9f0}h1{color:#4cc9f0;margin-bottom:20px}.info{background:#1a3a3a;padding:15px;border-radius:4px;margin:15px 0;border-left:3px solid #77dd77;color:#aaa;font-size:0.9em}input{width:100%;padding:10px;margin:10px 0;background:#1a1a2e;border:1px solid #4cc9f0;color:#fff;border-radius:4px}button{flex:1;padding:12px;background:#4cc9f0;color:#000;border:none;border-radius:4px;cursor:pointer;font-weight:bold}.buttons{display:flex;gap:10px;margin:15px 0}button:hover{background:#f72585}a{text-decoration:none}.stats{background:#1a1a2e;border:1px solid #4cc9f0;padding:15px;border-radius:4px;margin:20px 0}.stat-row{display:flex;justify-content:space-between;margin:10px 0}.stat-label{color:#aaa}.stat-value{color:#4cc9f0;font-weight:bold}.progress-bar{width:100%;height:20px;background:#1a1a2e;border-radius:10px;overflow:hidden;margin:10px 0}.progress-fill{height:100%;background:#4cc9f0;width:0%;transition:width 0.3s}.db-info{font-size:0.8em;color:#77dd77;margin-top:10px}</style></head><body><div class="container"><h1>🤖 IA Damek</h1><div class="info">✅ AVEC SUPABASE<br>🗄️ Données PERSISTANTES 100%<br>📊 Total: <strong id="tot">-</strong></div><input type="number" id="ep" value="500" min="10" max="1000"><div class="buttons"><button onclick="go()">🚀 Entraîner</button><button onclick="ref()">🔄 Refresh</button><a href="/analyse"><button>📊 Analyse</button></a></div><div class="stats"><div class="stat-row"><span class="stat-label">Partie:</span><span class="stat-value"><span id="e">-</span>/<span id="te">-</span></span></div><div class="stat-row"><span class="stat-label">Victoires:</span><span class="stat-value"><span id="w">-</span>%</span></div><div class="stat-row"><span class="stat-label">États:</span><span class="stat-value"><span id="st">-</span></span></div><div class="stat-row"><span class="stat-label">Epsilon:</span><span class="stat-value"><span id="eps">-</span></span></div><div class="progress-bar"><div class="progress-fill" id="pb"></div></div><div class="db-info">🗄️ <span id="db">-</span></div></div></div><script>async function go(){const n=parseInt(document.getElementById('ep').value);if(n<10){alert('Minimum 10 parties');return}try{const r=await fetch('/api/train/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({episodes:n})}),d=await r.json();if(d.error){alert('Erreur: '+d.error)}else{alert('Lancé! Démarrage: '+d.startFrom);ref()}}catch(e){alert('Erreur: '+e.message)}}async function ref(){try{const r1=await fetch('/api/train/status'),s1=await r1.json(),r2=await fetch('/api/stats'),s2=await r2.json();document.getElementById('e').textContent=s1.episode;document.getElementById('te').textContent=s1.totalEpisodes;document.getElementById('tot').textContent=s1.totalHistoryLength;document.getElementById('w').textContent=s1.winRate;document.getElementById('st').textContent=s1.states.toLocaleString();document.getElementById('eps').textContent=s2.epsilon;document.getElementById('db').textContent=s2.dbStatus;const p=s1.totalEpisodes?((s1.episode-s1.totalEpisodesSoFar)/(s1.totalEpisodes-s1.totalEpisodesSoFar+1)*100):0;document.getElementById('pb').style.width=p+'%';if(s1.running)setTimeout(ref,2000)}catch(e){console.error(e)}}ref();setInterval(ref,5000)</script></body></html>`);
});

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Serveur avec SUPABASE - PORT ${PORT}\n`);
  startHeartbeat();
});

server.on('error', (err) => console.error('Error:', err));
