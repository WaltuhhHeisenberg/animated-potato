/**
 * Three.js Story Video Renderer — Main App
 *
 * Loads scene map, transcript, style references and renders the video.
 * Style accuracy target: 90% against reference sheets.
 */

import * as THREE from 'three';
import { SceneMap } from './scene-map.js';
import { Transcript } from './transcript.js';
import { StyleAnalyzer } from './style-analyzer.js';
import { VideoRenderer } from './renderer.js';

class App {
  constructor() {
    this.sceneMap = new SceneMap();
    this.transcript = new Transcript();
    this.styleAnalyzer = new StyleAnalyzer();
    this.renderer = new VideoRenderer();

    this.currentPanel = 'overview';
    this.bindEvents();
    this.loadExistingData();
  }

  bindEvents() {
    // Panel navigation
    document.querySelectorAll('nav button').forEach(btn => {
      btn.addEventListener('click', () => this.showPanel(btn.dataset.panel));
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey) return;
      const panels = ['overview', 'scene-map', 'transcript', 'style', 'render', 'settings'];
      const idx = panels.indexOf(this.currentPanel);
      if (e.key === 'ArrowRight' && idx < panels.length - 1) this.showPanel(panels[idx + 1]);
      if (e.key === 'ArrowLeft' && idx > 0) this.showPanel(panels[idx - 1]);
    });
  }

  showPanel(name) {
    this.currentPanel = name;
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
    document.getElementById(`panel-${name}`)?.classList.add('active');
    document.querySelector(`nav button[data-panel="${name}"]`)?.classList.add('active');
  }

  async loadExistingData() {
    try {
      // Load scene map
      const sceneMapRes = await fetch('05-scene-map (1).json');
      if (sceneMapRes.ok) {
        const data = await sceneMapRes.json();
        this.sceneMap.load(data);
        this.updateSceneMapUI();
      }

      // Load transcript
      const transcriptRes = await fetch('transcript.csv');
      if (transcriptRes.ok) {
        const text = await transcriptRes.text();
        this.transcript.loadCSV(text);
        this.updateTranscriptUI();
      }

      // Load style references
      await this.styleAnalyzer.loadReferences('style/');
      this.updateStyleUI();

      this.updateOverviewStats();
    } catch (e) {
      console.warn('Could not load existing data:', e);
    }
  }

  updateOverviewStats() {
    const stats = this.getStats();
    document.getElementById('stat-scenes').textContent = stats.scenes;
    document.getElementById('stat-shots').textContent = stats.shots;
    document.getElementById('stat-duration').textContent = stats.duration.toFixed(1);
    document.getElementById('stat-style').textContent = stats.styleAccuracy + '%';
  }

  getStats() {
    const sm = this.sceneMap.data;
    const scenes = sm?.meta?.producer ? 1 : 0; // one video project
    const shots = sm?.shots?.length || 0;
    const duration = sm?.shots?.reduce((max, s) => Math.max(max, s.end), 0) || 0;
    const styleAccuracy = this.styleAnalyzer.lastScore || '--';
    return { scenes, shots, duration, styleAccuracy };
  }

  updateSceneMapUI() {
    const editor = document.getElementById('scene-map-editor');
    const preview = document.getElementById('scene-map-preview');
    if (editor) editor.value = JSON.stringify(this.sceneMap.data, null, 2);
    if (preview) preview.innerHTML = this.sceneMap.getSummaryHTML();
    this.updateOverviewStats();
  }

  updateTranscriptUI() {
    const editor = document.getElementById('transcript-editor');
    const preview = document.getElementById('transcript-preview');
    if (editor) editor.value = this.transcript.toJSON();
    if (preview) preview.innerHTML = this.transcript.getSummaryHTML();
    this.updateOverviewStats();
  }

  updateStyleUI() {
    const editor = document.getElementById('style-editor');
    const preview = document.getElementById('style-preview');
    if (editor) editor.value = this.styleAnalyzer.toJSON();
    if (preview) preview.innerHTML = this.styleAnalyzer.getSummaryHTML();
    this.updateOverviewStats();
  }

  // Panel action handlers
  loadSceneMap() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (file) {
        const text = await file.text();
        this.sceneMap.load(JSON.parse(text));
        this.updateSceneMapUI();
      }
    };
    input.click();
  }

  saveSceneMap() {
    const editor = document.getElementById('scene-map-editor');
    try {
      const data = JSON.parse(editor.value);
      this.sceneMap.load(data);
      this.updateSceneMapUI();
      alert('Scene map saved and validated.');
    } catch (e) {
      alert('Invalid JSON: ' + e.message);
    }
  }

  validateSceneMap() {
    const errors = this.sceneMap.validate();
    const preview = document.getElementById('scene-map-preview');
    if (errors.length) {
      preview.innerHTML = '<strong style="color: var(--warn)">Validation errors:</strong><ul>' +
        errors.map(e => `<li>${e}</li>`).join('') + '</ul>';
    } else {
      preview.innerHTML = '<strong style="color: var(--ok)">Scene map is valid ✓</strong>';
    }
  }

  loadTranscript() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,.json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (file) {
        const text = await file.text();
        if (file.name.endsWith('.csv')) this.transcript.loadCSV(text);
        else this.transcript.loadJSON(JSON.parse(text));
        this.updateTranscriptUI();
      }
    };
    input.click();
  }

  saveTranscript() {
    const editor = document.getElementById('transcript-editor');
    try {
      const data = JSON.parse(editor.value);
      this.transcript.loadJSON(data);
      this.updateTranscriptUI();
      alert('Transcript saved.');
    } catch (e) {
      alert('Invalid JSON: ' + e.message);
    }
  }

  calculateDuration() {
    const duration = this.transcript.getTotalDuration();
    const clauses = this.transcript.splitIntoClauses(this.sceneMap.data);
    const preview = document.getElementById('transcript-preview');
    preview.innerHTML = `<strong>Total duration:</strong> ${duration.toFixed(2)}s<br>
      <strong>Clauses:</strong> ${clauses.length}<br>
      <strong>Avg clause:</strong> ${(duration / clauses.length).toFixed(2)}s`;
  }

  loadStyle() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.md';
    input.multiple = true;
    input.onchange = async (e) => {
      const files = Array.from(e.target.files);
      await this.styleAnalyzer.loadFiles(files);
      this.updateStyleUI();
    };
    input.click();
  }

  saveStyle() {
    const editor = document.getElementById('style-editor');
    try {
      const data = JSON.parse(editor.value);
      this.styleAnalyzer.loadFromJSON(data);
      this.updateStyleUI();
      alert('Style reference saved.');
    } catch (e) {
      alert('Invalid JSON: ' + e.message);
    }
  }

  async checkStyleAccuracy() {
    const btn = document.querySelector('#panel-style .btn-secondary');
    btn.disabled = true;
    btn.textContent = 'Analyzing...';

    try {
      const score = await this.styleAnalyzer.analyze(this.sceneMap.data, this.transcript.data);
      const preview = document.getElementById('style-preview');
      preview.innerHTML = `
        <strong>Style Accuracy: ${score.overall}%</strong>
        <div class="gauge"><div class="gauge-fill" style="width: ${score.overall}%"></div></div>
        <table style="width:100%; margin-top:0.5rem; font-size:0.8rem;">
          <thead><tr><th>Dimension</th><th>Score</th><th>Target</th></tr></thead>
          <tbody>
            ${Object.entries(score.dimensions).map(([dim, val]) =>
              `<tr><td>${dim}</td><td>${val}%</td><td>≥80%</td></tr>`
            ).join('')}
          </tbody>
        </table>
        ${score.overall >= 90 && Object.values(score.dimensions).every(v => v >= 80)
          ? '<p style="color: var(--ok); margin-top: 0.5rem;">✓ PASS: Meets 90% overall, all dimensions ≥80%</p>'
          : '<p style="color: var(--warn); margin-top: 0.5rem;">✗ FAIL: Does not meet style gate requirements</p>'}
      `;
    } catch (e) {
      alert('Style analysis failed: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Check Style Accuracy';
    }
  }

  async renderVideo() {
    const resolution = document.getElementById('render-resolution').value;
    const fps = parseInt(document.getElementById('render-fps').value);
    const styleTarget = parseInt(document.getElementById('style-target').value);

    const [w, h] = resolution.split('x').map(Number);

    const progress = document.getElementById('render-progress');
    const status = document.getElementById('render-status');
    const fill = document.getElementById('render-fill');
    const output = document.getElementById('render-output');

    progress.classList.remove('hidden');
    output.classList.add('hidden');
    fill.style.width = '0%';
    status.textContent = 'Initializing renderer...';

    try {
      const result = await this.renderer.render({
        sceneMap: this.sceneMap.data,
        transcript: this.transcript.data,
        style: this.styleAnalyzer.data,
        width: w,
        height: h,
        fps: fps,
        styleTarget: styleTarget,
        onProgress: (p, msg) => {
          fill.style.width = (p * 100).toFixed(1) + '%';
          status.textContent = msg;
        }
      });

      output.classList.remove('hidden');
      output.innerHTML = `
        <strong style="color: var(--ok)">Render complete!</strong><br>
        Output: ${result.path}<br>
        Duration: ${result.duration.toFixed(2)}s<br>
        Frames: ${result.frames}<br>
        Style score: ${result.styleScore}%
        ${result.styleScore >= styleTarget ? '<br><span style="color: var(--ok)">✓ Style target met</span>' : '<br><span style="color: var(--warn)">✗ Style target not met</span>'}
      `;
      status.textContent = 'Done';
      fill.style.width = '100%';
    } catch (e) {
      status.textContent = 'Error: ' + e.message;
      fill.style.background = 'var(--warn)';
      console.error(e);
    }
  }

  saveSettings() {
    const settings = {
      styleTarget: document.getElementById('setting-style-target').value,
      resolution: document.getElementById('setting-resolution').value,
      inkLook: document.getElementById('setting-ink-look').checked,
      muxVoiceover: document.getElementById('setting-mux-voiceover').checked
    };
    localStorage.setItem('renderer-settings', JSON.stringify(settings));
    alert('Settings saved to localStorage.');
  }
}

// Initialize app
const app = new App();
window.app = app;

// Export for module use
export { App };