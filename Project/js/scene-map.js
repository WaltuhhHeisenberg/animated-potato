/**
 * Three.js Story Video Renderer — Scene Map module
 *
 * Handles loading, validation, and summary of the scene map JSON.
 * The scene map defines what to shoot: worlds, shots, props, characters, lighting, camera moves.
 */

export class SceneMap {
  constructor() {
    this.data = null;
    this.clauses = [];
    this.clipSummary = {
      totalShots: 0,
      totalDuration: 0,
      minShot: 0,
      maxShot: 0
    };
  }

  load(data) {
    this.data = data;
    this.parse();
  }

  parse() {
    if (!this.data) return;

    this.clauses = [];

    // Handle toon-studio format: shots array with start/end times and narration
    if (this.data.shots && Array.isArray(this.data.shots)) {
      this.clauses = this.data.shots.map((shot, i) => ({
        id: shot.id || `C${String(i).padStart(3, '0')}`,
        start: typeof shot.start === 'number' ? shot.start : 0,
        end: typeof shot.end === 'number' ? shot.end : 0,
        narration: shot.narration || '',
        storyFunction: shot.story_function || 'unknown',
        scene_type: shot.scene_type || 'unknown',
        setting: shot.setting || {},
        camera_moves: shot.camera_moves || [],
        actions: shot.actions || []
      }));
    }
    // Handle standard scene map format
    else if (this.data.clauses && Array.isArray(this.data.clauses)) {
      this.clauses = this.data.clauses.map((clause, i) => ({
        id: clause.id || `C${String(i).padStart(3, '0')}`,
        start: typeof clause.start === 'number' ? clause.start : i * 4,
        end: typeof clause.end === 'number' ? clause.end : (i + 1) * 4,
        narration: clause.narration || ''
      }));
    }
    // Try to extract from meta.notes
    else if (this.data.meta && this.data.meta.notes) {
      const notes = this.data.meta.notes;
      const match = notes.match(/(\d+)\.(\d+)\s*-\s*(\d+)\.(\d+)/g);
      if (match) {
        this.clauses = match.map((m, i) => {
          const parts = m.split(/\s*-\s*/);
          const [s1, e1] = parts[0].split('.').map(Number);
          const [s2, e2] = parts[1].split('.').map(Number);
          return { id: `C${String(i).padStart(3, '0')}`, start: s1 + e1/10, end: s2 + e2/10, narration: '' };
        });
      }
    }

    this.updateClipSummary();
  }

  updateClipSummary() {
    if (!this.clauses || this.clauses.length === 0) return;

    const durations = this.clauses.map(c => c.end - c.start);
    this.clipSummary = {
      totalShots: this.clauses.length,
      totalDuration: durations.reduce((a, b) => a + b, 0),
      minShot: Math.min(...durations),
      maxShot: Math.max(...durations)
    };
  }

  getSummaryHTML() {
    if (!this.data) return 'No scene map loaded.';

    const sm = this.data;
    const title = sm.meta?.title || 'Unnamed Scene Map';
    const producer = sm.meta?.producer || 'unknown';

    let html = `<div><strong>${title}</strong> (${producer})</div>`;

    // Show shot list summary
    if (this.clauses && this.clauses.length > 0) {
      html += `<div style="margin-top: 0.5rem; font-size: 0.85rem;">`;

      // Count by story function if available
      const funcCounts = {};
      this.clauses.forEach(c => {
        funcCounts[c.storyFunction] = (funcCounts[c.storyFunction] || 0) + 1;
      });

      html += `<strong>Clauses:</strong> ${this.clauses.length}`;
      html += `<br><strong>Duration:</strong> ${this.clipSummary.totalDuration.toFixed(1)}s (min: ${this.clipSummary.minShot.toFixed(1)}s, max: ${this.clipSummary.maxShot.toFixed(1)}s)`;

      if (Object.keys(funcCounts).length > 0) {
        html += `<br>Functions: `;
        html += Object.entries(funcCounts).map(([k, v]) => `${k}: ${v}`).join(', ');
      }

      html += `</div>`;
    }

    return html;
  }

  validate() {
    const errors = [];

    if (!this.data) {
      errors.push('No scene map data loaded.');
      return errors;
    }

    if (!this.data.shots || !Array.isArray(this.data.shots)) {
      errors.push('Scene map missing "shots" array.');
      return errors;
    }

    const validIDs = new Set();

    this.data.shots.forEach((shot, i) => {
      // Check for required fields
      if (!shot.id) errors.push(`Shot ${i}: missing "id"`);
      else if (validIDs.has(shot.id)) errors.push(`Duplicate shot id: "${shot.id}"`);
      else validIDs.add(shot.id);

      // Validate timing
      if (typeof shot.start !== 'number') errors.push(`Shot "${shot.id}": missing valid "start"`);
      if (typeof shot.end !== 'number') errors.push(`Shot "${shot.id}": missing valid "end"`);
      if (typeof shot.narration !== 'string') errors.push(`Shot "${shot.id}": missing "narration"`);

      // Check start < end
      if (typeof shot.start === 'number' && typeof shot.end === 'number' && shot.start >= shot.end) {
        errors.push(`Shot "${shot.id}": start (${shot.start}) >= end (${shot.end})`);
      }
    });

    return errors;
  }
}

// Export for use by main.js
window.SceneMap = SceneMap;