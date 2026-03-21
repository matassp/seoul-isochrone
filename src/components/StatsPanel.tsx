import { useEffect, useState } from "react";
import { useMapStore } from "../store/useMapStore";
import { LINE_COLORS } from "../constants/lines";
import type { LineId } from "../types";

type RankingEntry = {
  rank: number;
  id: string;
  nameKo: string;
  name: string;
  lines: string[];
  area15: number;
  area30: number;
  area60: number;
};

export default function StatsPanel() {
  const statsPanelOpen = useMapStore((s) => s.statsPanelOpen);
  const toggleStatsPanel = useMapStore((s) => s.toggleStatsPanel);
  const selectedStation = useMapStore((s) => s.selectedStation);
  const stations = useMapStore((s) => s.stations);
  const selectStation = useMapStore((s) => s.selectStation);

  const [rankings, setRankings] = useState<RankingEntry[]>([]);

  useEffect(() => {
    if (!statsPanelOpen || rankings.length > 0) return;
    fetch(`${import.meta.env.BASE_URL}data/rankings.json`)
      .then((r) => r.json())
      .then(setRankings)
      .catch(() => {});
  }, [statsPanelOpen, rankings.length]);

  const top15 = rankings.slice(0, 15);

  return (
    <div className={`stats-panel ${statsPanelOpen ? "open" : "closed"}`}>
      <div className="stats-masthead">
        <div className="stats-masthead-inner">
          <h2 className="stats-title">Data</h2>
          <button className="stats-close" onClick={toggleStatsPanel} aria-label="Close">✕</button>
        </div>
        <div className="stats-subtitle">Accessibility Analysis</div>
      </div>

      {/* Table 1 */}
      <div className="stats-section">
        <h3>Table 1 — Accessibility Ranking</h3>
        {top15.length === 0 ? (
          <div className="loading">Loading…</div>
        ) : (
          <>
            <table className="stats-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Station</th>
                  <th title="Reachable area in km² within 15 min">15′ km²</th>
                </tr>
              </thead>
              <tbody>
                {top15.map((r) => (
                  <tr
                    key={r.id}
                    className={`ranking-row${selectedStation?.id === r.id ? " active" : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Select ${r.name} station`}
                    onClick={() => {
                      const s = stations.find((st) => st.id === r.id);
                      if (s) selectStation(s);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        const s = stations.find((st) => st.id === r.id);
                        if (s) selectStation(s);
                      }
                    }}
                  >
                    <td className="ranking-rank">{r.rank}</td>
                    <td className="ranking-name">
                      <span className="ranking-ko">{r.nameKo}</span>
                      {r.name !== r.nameKo && <span className="ranking-en">{r.name}</span>}
                      <span className="ranking-lines">
                        {r.lines.map((l) => (
                          <span key={l} className="line-dot" style={{ backgroundColor: LINE_COLORS[l as LineId] }} />
                        ))}
                      </span>
                    </td>
                    <td className="ranking-area">{r.area15}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="section-note" style={{ marginTop: 8 }}>
              Area in km² · ranked by 15 min · off-peak
            </div>
          </>
        )}
      </div>
    </div>
  );
}
