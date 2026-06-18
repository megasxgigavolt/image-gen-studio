import {
  FolderOpen,
  Home,
  Image,
  Moon,
  Plus,
  Settings,
  Sparkles,
  Sun,
  Upload,
  WandSparkles,
} from "lucide-react";
import { useEffect } from "react";
import { demoSentences } from "./data/demo";
import { deriveGroupTiming } from "./domain/visual-plan";
import { type AppStage, useAppStore } from "./store/app-store";
import { log } from "./infrastructure/logger";

const navItems: { stage: AppStage; label: string; icon: typeof Home }[] = [
  { stage: "home", label: "Home", icon: Home },
  { stage: "inputs", label: "Inputs", icon: Upload },
  { stage: "visual-plan", label: "Visual plan", icon: FolderOpen },
  { stage: "images", label: "Images", icon: Image },
];

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = (seconds % 60).toFixed(1).padStart(4, "0");
  return `${String(minutes).padStart(2, "0")}:${remainder}`;
}

function Sidebar() {
  const { stage, setStage } = useAppStore();
  return (
    <aside className="sidebar">
      <button className="brand" onClick={() => setStage("home")}>
        <span className="brand-mark"><span /></span>
        <span>Auto Gen <strong>Studio</strong></span>
      </button>
      <nav>
        {navItems.map(({ stage: itemStage, label, icon: Icon }) => (
          <button
            className={stage === itemStage ? "nav-item active" : "nav-item"}
            key={itemStage}
            onClick={() => setStage(itemStage)}
          >
            <Icon size={18} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <button className="nav-item settings"><Settings size={18} /><span>Settings</span></button>
    </aside>
  );
}

function Header() {
  const { theme, toggleTheme } = useAppStore();
  return (
    <header className="topbar">
      <div><span>Beneath the Fins</span><b>/</b><strong>The Ocean's Twilight Zone</strong></div>
      <div className="top-actions">
        <span className="saved">Saved locally</span>
        <button className="icon-button" onClick={toggleTheme} aria-label="Toggle theme">
          {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
        </button>
      </div>
    </header>
  );
}

function HomeView() {
  const setStage = useAppStore((state) => state.setStage);
  return (
    <section className="view">
      <div className="page-heading">
        <div><p className="eyebrow">Workspace</p><h1>Good evening, Ahmed</h1><p>Continue a video or begin a new production.</p></div>
        <button className="primary" onClick={() => setStage("inputs")}><Plus size={17} />New video</button>
      </div>
      <button className="resume-band" onClick={() => setStage("images")}>
        <div><span>CONTINUE WHERE YOU LEFT OFF</span><h2>The Ocean's Twilight Zone</h2><p>12 of 18 stills generated · Image generation</p></div>
        <strong>→</strong>
      </button>
      <div className="section-heading"><h2>Channels</h2><button>+ Add channel</button></div>
      <div className="home-grid">
        <div className="channel-list">
          <button className="channel active"><span>BF</span><div><strong>Beneath the Fins</strong><small>4 videos</small></div></button>
          <button className="channel"><span>HF</span><div><strong>Hidden Frontiers</strong><small>2 videos</small></div></button>
        </div>
        <div className="video-grid">
          {["The Ocean's Twilight Zone", "Why Coral Reefs Glow at Night", "The Secret Language of Whales"].map((title, index) => (
            <button className="video-card" key={title} onClick={() => setStage(index === 0 ? "images" : "visual-plan")}>
              <div className={`video-art art-${index + 1}`}><span>{index === 0 ? "12 / 18" : index === 1 ? "18 scenes" : "Complete"}</span></div>
              <div><small>{index === 2 ? "EXPORTED" : "IN PROGRESS"}</small><h3>{title}</h3><p>{index === 0 ? "Image generation" : "Visual plan"} · Edited recently</p><i style={{ width: `${index === 2 ? 100 : index === 1 ? 38 : 67}%` }} /></div>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function InputsView() {
  const setStage = useAppStore((state) => state.setStage);
  return (
    <section className="view">
      <div className="page-heading"><div><p className="eyebrow">Stage 1 of 3</p><h1>Source material</h1><p>Add narration and references that will guide the visual plan.</p></div></div>
      <div className="inputs-grid">
        <article className="panel script-panel">
          <div className="panel-heading"><div><h2>Script</h2><p>Paste narration or import a text file.</p></div><button className="secondary"><Upload size={15} />Import</button></div>
          <textarea defaultValue="Far below the sunlit surface lies a world suspended between light and darkness. Oceanographers call it the twilight zone, a vast layer stretching from two hundred to one thousand meters deep." />
          <footer><span>1,248 words</span><span>Approx. 8 min 20 sec</span></footer>
        </article>
        <div className="panel-stack">
          <article className="panel"><h2>Narration audio</h2><p>Used for word-level timing.</p><div className="file-row"><span>▶</span><div><strong>twilight-zone-final.wav</strong><small>08:17 · WAV · 79.6 MB</small></div></div></article>
          <article className="panel"><div className="panel-heading"><div><h2>Visual references</h2><p>Optional style and subject guidance.</p></div><button className="secondary"><Plus size={15} />Add</button></div><div className="reference-strip"><span /><span /><button>+</button></div></article>
          <article className="panel"><h2>Scene pacing</h2><p>Target duration per still</p><input type="range" min="4" max="14" defaultValue="8" /></article>
        </div>
      </div>
      <div className="footer-actions"><button className="secondary" onClick={() => setStage("home")}>Back</button><button className="primary" onClick={() => setStage("visual-plan")}>Generate visual plan →</button></div>
    </section>
  );
}

function VisualPlanView() {
  const { visualPlan, moveSentence, resetVisualPlan, setStage } = useAppStore();
  return (
    <section className="view">
      <div className="page-heading">
        <div><p className="eyebrow">Stage 2 of 3</p><h1>Visual plan</h1><p>Drag a sentence into an adjacent still to regroup it. Chronological order remains enforced.</p></div>
        <div className="heading-actions"><button className="secondary" onClick={resetVisualPlan}>Reset original</button><button className="primary" onClick={() => setStage("images")}>Continue to images →</button></div>
      </div>
      <div className="plan-summary"><strong>{visualPlan.length} stills</strong><span>Original AI plan is always recoverable</span></div>
      <div className="plan-list">
        {visualPlan.map((group, index) => {
          const timing = deriveGroupTiming(group, demoSentences);
          return (
            <article
              className="plan-row"
              key={group.id}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => moveSentence(event.dataTransfer.getData("text/sentence-id"), group.id)}
            >
              <span className="plan-index">{String(index + 1).padStart(2, "0")}</span>
              <div className="timing"><strong>{formatTime(timing.startSeconds)} – {formatTime(timing.endSeconds)}</strong><small>{timing.durationSeconds.toFixed(1)} sec</small></div>
              <div className="sentences">
                {timing.members.map((sentence) => (
                  <div
                    className="sentence"
                    draggable
                    key={sentence.id}
                    onDragStart={(event) => event.dataTransfer.setData("text/sentence-id", sentence.id)}
                  >
                    <b>⠿</b><span>{sentence.text}</span><small>{formatTime(sentence.startSeconds)}</small>
                  </div>
                ))}
              </div>
              <div className="scene-label"><span>{group.kind}</span><small>{group.label}</small></div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ImagesView() {
  return (
    <section className="view image-view">
      <div className="page-heading"><div><p className="eyebrow">Stage 3 of 3</p><h1>Image generation</h1></div><button className="primary"><WandSparkles size={17} />Generate pending</button></div>
      <div className="image-workspace">
        <aside className="stills"><strong>Stills <span>12/18</span></strong>{[1,2,3,4,5,6].map((item) => <button className={item === 4 ? "active" : ""} key={item}><span>{item < 6 ? `v${(item % 3) + 1}` : "Pending"}</span><small>Still {String(item).padStart(2, "0")}</small></button>)}</aside>
        <div className="preview"><header><span>Still 04</span><strong>00:26.4 – 00:35.8</strong></header><div className="preview-art"><Sparkles size={42} /><p>Generated image preview</p></div><footer>Far below the sunlit surface lies a world suspended between light and darkness.</footer></div>
        <aside className="prompt-panel"><div className="tabs"><button className="active">Prompt</button><button>Settings</button></div><label>Scene prompt<textarea defaultValue="A wide cinematic view descending into the ocean's twilight zone, faint shafts of blue sunlight dissolving into darkness, suspended particles, immense scale, scientifically accurate deep-sea environment." /></label><button className="secondary"><Sparkles size={15} />Suggest improvement</button><button className="primary full">Generate new version</button><div className="placeholder"><strong>Animation</strong><span>Planned for a later release</span></div></aside>
      </div>
    </section>
  );
}

export function App() {
  const { stage, theme } = useAppStore();
  useEffect(() => document.documentElement.setAttribute("data-theme", theme), [theme]);
  useEffect(() => log("info", "application_started", { release: "0.1.0" }), []);
  useEffect(() => log("debug", "stage_opened", { stage }), [stage]);
  return (
    <div className="app-shell">
      <Sidebar />
      <main><Header />{stage === "home" && <HomeView />}{stage === "inputs" && <InputsView />}{stage === "visual-plan" && <VisualPlanView />}{stage === "images" && <ImagesView />}</main>
    </div>
  );
}
