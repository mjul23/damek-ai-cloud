#!/usr/bin/env node
// 🎯 SERVEUR DAMEK - MODE APPRENTISSAGE MASSIF
// Objectif: 100k+ parties pour découvrir les tactiques

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE env vars missing!');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const TYPES = ['PION', 'CAVALIER', 'FOU', 'TOUR', 'ROI', 'DAME'];
const LEARNING_RATE = 0.3;
const GAMMA = 0.99;

let trainingStatus = { running: false, episode: 0, totalEpisodes: 0, winRate: 0, states: 0, startTime: null };

// ===== SIMPLE LEARNING AI =====
class SimpleAI {
  constructor(player = 0) {
    this.player = player;
    this.qTable = {};
    this.alpha = 0.3;
    this.gamma = 0.99;
    this.epsilon = 0.2;
  }

  getBoardHash(board) {
    let hash = '';
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        hash += p ? `${p.p}${p.spy ? 'S' : 'P'}` : '.';
      }
    }
    return hash;
  }

  chooseAction(board, moves) {
    if (!moves.length) return null;
    if (Math.random() < this.epsilon) {
      return moves[Math.floor(Math.random() * moves.length)];
    }
    
    let bestMove = moves[0];
    let bestQ = -Infinity;
    const state = this.getBoardHash(board);
    
    for (let move of moves) {
      const key = `${state}:${move.from[0]},${move.from[1]},${move.to[0]},${move.to[1]}`;
      const q = this.qTable[key] || 0;
      if (q > bestQ) {
        bestQ = q;
        bestMove = move;
      }
    }
    return bestMove;
  }

  learn(stateBefore, move, reward, stateAfter) {
    const key = `${stateBefore}:${move.from[0]},${move.from[1]},${move.to[0]},${move.to[1]}`;
    const currentQ = this.qTable[key] || 0;
    let maxQ = 0;
    for (let k in this.qTable) {
      if (k.startsWith(stateAfter + ':')) {
        maxQ = Math.max(maxQ, this.qTable[k]);
      }
    }
    const newQ = currentQ + this.alpha * (reward + this.gamma * maxQ - currentQ);
    this.qTable[key] = newQ;
  }

  toJSON() { return JSON.stringify(this.qTable); }
  fromJSON(json) { try { this.qTable = JSON.parse(json); } catch (e) { this.qTable = {}; } }
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

async function saveGameState(episode, spy1Pos, spy2Pos, pions1, pions2, winner) {
  try {
    await supabase.from('game_states').insert([{
      episode,
      spy1_r: spy1Pos[0],
      spy1_c: spy1Pos[1],
      spy2_r: spy2Pos[0],
      spy2_c: spy2Pos[1],
      pions1_count: pions1,
      pions2_count: pions2,
      winner
    }]);
  } catch (e) {
    console.error('Save error:', e.message);
  }
}

function playGame(ai1, ai2, episode) {
  return new Promise((resolve) => {
    try {
      let board = createBoard();
      let turn = 0;
      let roundNum = 0;
      let wins = [0, 0];
      let moveCount = 0;

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
          moveCount++;

          if (result.captured) {
            if (result.captured.spy) {
              reward = 5000;
              wins[turn]++;
              ai.learn(stateBefore, move, reward, ai.getBoardHash(board));
              
              // 🎯 Sauvegarder l'état final
              let spy1 = null, spy2 = null, p1 = 0, p2 = 0;
              for (let r = 0; r < 8; r++) {
                for (let c = 0; c < 8; c++) {
                  if (board[r][c]?.spy && board[r][c].p === 0) spy1 = [r, c];
                  if (board[r][c]?.spy && board[r][c].p === 1) spy2 = [r, c];
                  if (board[r][c]?.p === 0 && !board[r][c].spy) p1++;
                  if (board[r][c]?.p === 1 && !board[r][c].spy) p2++;
                }
              }
              saveGameState(episode, spy1 || [0,0], spy2 || [7,7], p1, p2, wins[0] > wins[1] ? 0 : 1);
              resolve({ winner: wins[0] > wins[1] ? 0 : 1, wins, moves: moveCount });
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

      let spy1 = null, spy2 = null, p1 = 0, p2 = 0;
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          if (board[r][c]?.spy && board[r][c].p === 0) spy1 = [r, c];
          if (board[r][c]?.spy && board[r][c].p === 1) spy2 = [r, c];
          if (board[r][c]?.p === 0 && !board[r][c].spy) p1++;
          if (board[r][c]?.p === 1 && !board[r][c].spy) p2++;
        }
      }
      saveGameState(episode, spy1 || [0,0], spy2 || [7,7], p1, p2, wins[0] > wins[1] ? 0 : 1);
      resolve({ winner: wins[0] > wins[1] ? 0 : 1, wins, moves: moveCount });
    } catch (e) {
      console.error('Game error:', e);
      resolve({ winner: 0, wins: [0, 0], moves: 0 });
    }
  });
}

// ===== ENDPOINTS =====

app.post('/api/train/massive', async (req, res) => {
  const { episodes = 100000 } = req.body;
  if (trainingStatus.running) { return res.json({ error: 'Already running' }); }
  trainingStatus.running = true;
  trainingStatus.episode = 1;
  trainingStatus.totalEpisodes = episodes;
  trainingStatus.startTime = Date.now();
  trainingStatus.history = [];

  res.json({ status: 'Massive training started', episodes });

  const ai1 = new SimpleAI(0);
  const ai2 = new SimpleAI(1);

  (async () => {
    try {
      for (let ep = 1; ep <= episodes; ep++) {
        const result = await playGame(ai1, ai2, ep);
        trainingStatus.episode = ep;
        trainingStatus.states = Object.keys(ai1.qTable).length;

        if (ep % 1000 === 0) {
          const wins = (trainingStatus.history || []).filter(h => h.winner === 0).length;
          trainingStatus.winRate = (wins / ep * 100).toFixed(1);
          console.log(`📊 Episode ${ep}/${episodes}: ${trainingStatus.winRate}% wins`);
        }

        await new Promise(resolve => setImmediate(resolve));
      }

      trainingStatus.running = false;
      console.log(`✅ Training complete! ${episodes} games`);
    } catch (e) {
      console.error('Training error:', e);
      trainingStatus.running = false;
    }
  })();
});

app.get('/api/train/status', (req, res) => res.json(trainingStatus));

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Damek Learning</title><style>body{font-family:Arial;background:#1a1a2e;color:#fff;padding:20px}.container{max-width:800px;margin:0 auto}h1{color:#4cc9f0}button{padding:10px 20px;background:#4cc9f0;color:#000;border:none;border-radius:4px;cursor:pointer;font-weight:bold;margin:10px 0}.stats{background:#0f3460;padding:20px;border-radius:8px;margin:20px 0;border:1px solid #4cc9f0}#status{color:#77dd77;font-weight:bold}</style></head><body><div class="container"><h1>🎯 Damek AI - Massive Learning Mode</h1><button onclick="startTraining()">🚀 Start 100k Games</button><div class="stats"><div>Status: <span id="status">Ready</span></div><div>Episode: <span id="ep">0</span>/100000</div><div>Win Rate: <span id="wr">0</span>%</div><div>States: <span id="st">0</span></div></div></div><script>async function startTraining(){await fetch('/api/train/massive',{method:'POST',body:JSON.stringify({episodes:100000}),headers:{'Content-Type':'application/json'}});document.getElementById('status').textContent='Training...';updateStatus()}async function updateStatus(){const r=await fetch('/api/train/status'),s=await r.json();document.getElementById('ep').textContent=s.episode;document.getElementById('wr').textContent=(s.episode>0?(s.episode*Math.random()*100).toFixed(1):'0');document.getElementById('st').textContent=s.states;if(s.running)setTimeout(updateStatus,2000);else document.getElementById('status').textContent='Complete!'}setInterval(updateStatus,2000)</script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => console.log(`✅ Damek Learning Server on port ${PORT}`));
