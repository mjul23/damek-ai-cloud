#!/usr/bin/env node
// 🤖 SERVEUR DAMEK - REPLAY MODE (epsilon=0 + enregistrement moves)

const express = require('express');
const fs = require('fs');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

console.log(`\n✅ SERVEUR REPLAY - PORT ${PORT}\n`);

// SUPABASE CONFIG
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Ajoute SUPABASE_URL et SUPABASE_KEY dans Render!');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
console.log(`✅ Connecté à Supabase`);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const TYPES = ['PION', 'CAVALIER', 'FOU', 'TOUR', 'ROI', 'DAME'];
const LEARNING_RATE = 0.25;
const GAMMA = 0.99;

let trainingStatus = { 
  running: false, 
  episode: 0, 
  totalEpisodes: 0, 
  winRate: 0, 
  states: 0, 
  epsilon: 0, 
  startTime: null, 
  history: [],
  dbStatus: 'READY'
};

// ===== SUPABASE FUNCTIONS =====

async function saveMoveToSupabase(episode, moveNumber, player, fromPos, toPos, isCapture, reward, gameResult, epsilon, aiStates) {
  try {
    await supabase.from('moves').insert([{
      episode, move_number: moveNumber, player,
      from_r: fromPos[0], from_c: fromPos[1],
      to_r: toPos[0], to_c: toPos[1],
      is_capture: isCapture, reward: parseFloat(reward),
      game_result: gameResult, epsilon: parseFloat(epsilon), ai_states: aiStates
    }]);
    return true;
  } catch (e) {
    console.error(`❌ Erreur save move:`, e.message);
    return false;
  }
}

async function savePartyToSupabase(party) {
  try {
    await supabase.from('history').insert([{
      episode: party.episode, winner: party.winner,
      ai_score: party.ai_score, opp_score: party.opp_score,
      epsilon: 0, ai_states: party.ai_states
    }]);
    return true;
  } catch (e) {
    console.error(`❌ Erreur save party:`, e.message);
    return false;
  }
}

async function loadModelsFromSupabase() {
  try {
    const { data } = await supabase.from('models').select('*').eq('id', 1).single();
    return { ai1: data?.ai1_model, ai2: data?.ai2_model };
  } catch (e) {
    console.error(`⚠️ Erreur chargement modèles:`, e.message);
    return { ai1: null, ai2: null };
  }
}

// ===== GAME ENGINE =====

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
  constructor(player = 0) { this.player = player; this.qTable = {}; this.alpha = LEARNING_RATE; this.gamma = GAMMA; this.epsilon = 0; }
  getBoardHash(board) { let hash = ''; for (let r = 0; r < 8; r++) { for (let c = 0; c < 8; c++) { const p = board[r][c]; hash += p ? `${p.p}${p.spy ? 'S' : ''}` : '.'; } } return hash; }
  chooseAction(board, moves) { if (!moves.length) return null; let bestMove = moves[0]; let bestQ = -Infinity; for (let move of moves) { const key = `${this.getBoardHash(board)}:${move.from[0]},${move.from[1]},${move.to[0]},${move.to[1]}`; const q = this.qTable[key] || 0; if (q > bestQ) { bestQ = q; bestMove = move; } } return bestMove; }
  learn(stateBefore, move, reward, stateAfter) { const key = `${stateBefore}:${move.from[0]},${move.from[1]},${move.to[0]},${move.to[1]}`; const currentQ = this.qTable[key] || 0; let maxQ = 0; for (let k in this.qTable) { if (k.startsWith(stateAfter + ':')) { maxQ = Math.max(maxQ, this.qTable[k]); } } const newQ = currentQ + this.alpha * (reward + this.gamma * maxQ - currentQ); this.qTable[key] = newQ; }
  toJSON() { return JSON.stringify(this.qTable); }
  fromJSON(json) { try { this.qTable = JSON.parse(json); } catch (e) { this.qTable = {}; } }
}

let ai1 = new DamekAI(0);
let ai2 = new DamekAI(1);

// Charger les modèles
loadModelsFromSupabase().then(models => {
  if (models.ai1) ai1.fromJSON(models.ai1);
  if (models.ai2) ai2.fromJSON(models.ai2);
  console.log(`✅ Modèles chargés`);
});

// ===== GAME PLAY =====

function playGameWithMoves(ai1, ai2, episode) {
  return new Promise((resolve) => {
    try {
      let board = createBoard();
      let turn = 0;
      let roundNum = 0;
      let wins = [0, 0];
      let movesRecorded = 0;
      let moveNumber = 0;

      while (wins[0] < 3 && wins[1] < 3 && roundNum < 50) {
        roundNum++;
        turn = 0;
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
          moveNumber++;

          if (result.captured) {
            if (result.captured.spy) {
              reward = 5000;
              wins[turn]++;
              saveMoveToSupabase(episode, moveNumber, turn, move.from, move.to, true, reward, wins[0] > wins[1] ? 0 : 1, 0, Object.keys(ai1.qTable).length);
              movesRecorded++;
              resolve({ winner: wins[0] > wins[1] ? 0 : 1, wins, movesRecorded });
              return;
            } else {
              reward = 200;
            }
          }

          const stateAfter = ai.getBoardHash(board);
          ai.learn(stateBefore, move, reward, stateAfter);
          saveMoveToSupabase(episode, moveNumber, turn, move.from, move.to, result.captured ? true : false, reward, wins[0] > wins[1] ? 0 : 1, 0, Object.keys(ai1.qTable).length);
          movesRecorded++;
          turn = 1 - turn;
        }
      }

      resolve({ winner: wins[0] > wins[1] ? 0 : 1, wins, movesRecorded });
    } catch (e) {
      console.error('Game error:', e);
      resolve({ winner: 0, wins: [0, 0], movesRecorded: 0 });
    }
  });
}

// ===== ENDPOINTS =====

app.post('/api/train/replay', async (req, res) => {
  const { episodes = 1000 } = req.body;
  if (trainingStatus.running) { return res.json({ error: 'Replay déjà en cours' }); }
  trainingStatus.running = true;
  trainingStatus.episode = 1;
  trainingStatus.totalEpisodes = episodes;
  trainingStatus.startTime = Date.now();
  trainingStatus.history = [];
  trainingStatus.epsilon = 0;

  res.json({ status: 'Replay lancé (epsilon=0)', episodes });

  (async () => {
    try {
      for (let ep = 1; ep <= episodes; ep++) {
        const result = await playGameWithMoves(ai1, ai2, ep);
        trainingStatus.episode = ep;
        trainingStatus.states = Object.keys(ai1.qTable).length;

        const newEntry = { episode: ep, winner: result.winner, ai_score: result.wins[0], opp_score: result.wins[1], ai_states: trainingStatus.states };
        trainingStatus.history.push(newEntry);

        await savePartyToSupabase(newEntry);

        if (ep % 50 === 0) {
          const wins = trainingStatus.history.filter(h => h.winner === 0).length;
          trainingStatus.winRate = (wins / trainingStatus.history.length * 100).toFixed(1);
          console.log(`🎯 Replay ${ep}/${episodes}: Win=${trainingStatus.winRate}%, Moves=${result.movesRecorded}`);
        }

        await new Promise(resolve => setImmediate(resolve));
      }

      trainingStatus.running = false;
      console.log(`✅ Replay terminé! ${episodes} parties avec ${Object.keys(ai1.qTable).length} états`);
    } catch (e) {
      console.error('Replay error:', e);
      trainingStatus.running = false;
    }
  })();
});

app.get('/api/train/status', (req, res) => res.json(trainingStatus));

app.get('/api/moves/analysis', async (req, res) => {
  try {
    const { data, error } = await supabase.from('moves').select('*').order('episode', { ascending: true });
    
    if (error) return res.json({ error: error.message });

    const analysis = {
      totalMoves: data.length,
      gameResults: { ai1Wins: 0, ai2Wins: 0 },
      topWinningMoves: [],
      rewardStats: {}
    };

    data.forEach(move => {
      if (move.game_result === 0) analysis.gameResults.ai1Wins++;
      else analysis.gameResults.ai2Wins++;

      const key = `${move.from_r}-${move.from_c}→${move.to_r}-${move.to_c}`;
      const existing = analysis.topWinningMoves.find(m => m.move === key);
      if (existing && move.game_result === 0) {
        existing.count++;
      } else if (move.game_result === 0) {
        analysis.topWinningMoves.push({ move: key, count: 1, reward: move.reward });
      }
    });

    analysis.topWinningMoves.sort((a, b) => b.count - a.count).slice(0, 50);
    res.json(analysis);
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get('/patterns', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Patterns</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial;background:#1a1a2e;color:#fff;padding:20px}.container{max-width:1200px;margin:0 auto}h1{color:#4cc9f0;text-align:center}button{padding:10px;background:#4cc9f0;color:#000;border:none;border-radius:4px;cursor:pointer;margin:10px}.stats{background:#0f3460;padding:20px;border-radius:8px;margin:20px 0;border:1px solid #4cc9f0}table{width:100%;border-collapse:collapse;margin:20px 0}th,td{padding:10px;text-align:left;border-bottom:1px solid #4cc9f0}th{background:#1a5f7a}</style></head><body><div class="container"><h1>🎯 Patterns Gagnants</h1><button onclick="launchReplay()">🎮 Lancer Replay (1000)</button><button onclick="loadAnalysis()">📊 Charger Analysis</button><div class="stats"><div>Total Moves: <strong id="tm">-</strong></div><div>AI1 Wins: <strong id="w1">-</strong></div><div>AI2 Wins: <strong id="w2">-</strong></div></div><h2>Top Moves</h2><div id="moves"></div></div><script>async function launchReplay(){if(!confirm('Lancer 1000 parties?')) return;const r=await fetch('/api/train/replay',{method:'POST',body:JSON.stringify({episodes:1000}),headers:{'Content-Type':'application/json'}});alert('Replay lancé!');setInterval(loadAnalysis,5000)}async function loadAnalysis(){const r=await fetch('/api/moves/analysis'),a=await r.json();document.getElementById('tm').textContent=a.totalMoves;document.getElementById('w1').textContent=a.gameResults.ai1Wins;document.getElementById('w2').textContent=a.gameResults.ai2Wins;let html='<table><tr><th>Rank</th><th>Move</th><th>Count</th></tr>';a.topWinningMoves.forEach((m,i)=>{html+=`<tr><td>${i+1}</td><td>${m.move}</td><td>${m.count}</td></tr>`});html+='</table>';document.getElementById('moves').innerHTML=html}loadAnalysis();setInterval(loadAnalysis,10000)</script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => console.log(`✅ Serveur REPLAY sur port ${PORT}`));
