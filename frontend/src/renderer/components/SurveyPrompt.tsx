import { useState, useSyncExternalStore } from "react";

import {
	answerCurrentSurvey,
	dismissCurrentSurvey,
	getCurrentSurvey,
	subscribeSurvey,
} from "../lib/survey";

// Scoped styles, injected once. They lean on AO's own theme tokens
// (--color-popover, --color-accent, …) so the card tracks light/dark with the
// rest of the app and needs no Tailwind utility guesswork.
const STYLE_ID = "ao-survey-styles";
const CSS = `
@keyframes ao-survey-rise{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}
.aoq{position:fixed;bottom:18px;right:18px;z-index:60;width:320px;
  background:var(--color-popover,#fff);color:var(--color-popover-foreground,#141821);
  border:1px solid var(--color-border,#e6e9ef);border-radius:16px;
  box-shadow:0 1px 2px rgba(0,0,0,.10),0 18px 44px -14px rgba(0,0,0,.45);
  padding:15px 16px 14px;animation:ao-survey-rise .22s cubic-bezier(.2,.7,.2,1);font-size:14px}
.aoq-hd{display:flex;align-items:center;gap:7px;margin-bottom:9px}
.aoq-dot{width:15px;height:15px;border-radius:5px;flex:none;background:var(--color-accent,#2f5ff0);
  box-shadow:0 0 0 4px var(--color-accent-weak,#f0f4ff)}
.aoq-eye{font-size:11px;font-weight:700;color:var(--color-muted-foreground,#6b7480)}
.aoq-x{margin-left:auto;width:22px;height:22px;border:none;background:none;cursor:pointer;border-radius:6px;
  font-size:16px;line-height:1;color:var(--color-muted-foreground,#9aa2ad)}
.aoq-x:hover{color:var(--color-popover-foreground,#141821);background:var(--color-accent-weak,#eef1f5)}
.aoq-q{margin:0 0 12px;font-size:15px;font-weight:600;letter-spacing:-.01em;line-height:1.35}
.aoq-opts{display:flex;flex-direction:column;gap:7px}
.aoq-opt{position:relative;text-align:left;cursor:pointer;font:inherit;font-size:13.5px;
  border:1px solid var(--color-border,#e6e9ef);background:transparent;color:inherit;border-radius:11px;padding:9px 12px;
  transition:background .13s,border-color .13s}
.aoq-opt:hover{background:var(--color-accent-weak,#f0f4ff);border-color:var(--color-accent,#2f5ff0)}
.aoq-opt.sel{background:var(--color-accent,#2f5ff0);color:var(--color-accent-foreground,#fff);
  border-color:var(--color-accent,#2f5ff0);font-weight:600}
.aoq-opt.sel::after{content:"✓";position:absolute;right:12px;top:50%;transform:translateY(-50%);font-size:12px}
.aoq-foot{margin-top:11px;font-size:11px;color:var(--color-muted-foreground,#9aa2ad)}
.aoq-ta{width:100%;min-height:74px;resize:none;font:inherit;font-size:13.5px;color:inherit;
  background:var(--color-bg-primary,#f6f7f9);border:1px solid var(--color-border,#e6e9ef);border-radius:11px;padding:9px 11px}
.aoq-ta:focus{outline:none;border-color:var(--color-accent,#2f5ff0)}
.aoq-row{display:flex;gap:8px;margin-top:9px}
.aoq-send{flex:1;font:inherit;font-size:13.5px;font-weight:600;cursor:pointer;border:none;border-radius:11px;padding:9px;
  background:var(--color-accent,#2f5ff0);color:var(--color-accent-foreground,#fff)}
.aoq-skip{font:inherit;font-size:13px;cursor:pointer;border:1px solid var(--color-border,#e6e9ef);background:none;
  color:var(--color-muted-foreground,#6b7480);border-radius:11px;padding:9px 14px}
.aoq-thanks{display:flex;align-items:center;gap:8px;font-weight:500;padding:6px 0}
.aoq-ok{width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;
  background:var(--color-accent,#2f5ff0);color:var(--color-accent-foreground,#fff)}
`;
function ensureStyles() {
	if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
	const el = document.createElement("style");
	el.id = STYLE_ID;
	el.textContent = CSS;
	document.head.appendChild(el);
}

/**
 * The single, unobtrusive survey card. Renders nothing until a trigger offers a
 * survey; the controller guarantees at most one per user per week. Supports one
 * tap (auto-submit), multi-select (+ Done), and short answer (+ Send / Skip).
 */
export function SurveyPrompt() {
	const survey = useSyncExternalStore(subscribeSurvey, getCurrentSurvey, getCurrentSurvey);
	const [picked, setPicked] = useState<string[]>([]);
	const [text, setText] = useState("");
	const [thanks, setThanks] = useState<string | null>(null);

	ensureStyles();
	if (!survey && !thanks) return null;

	const finish = (msg: string, submit?: () => void) => {
		submit?.();
		setPicked([]);
		setText("");
		setThanks(msg);
		window.setTimeout(() => setThanks(null), 1400);
	};

	if (thanks) {
		return (
			<div className="aoq" role="status">
				<div className="aoq-thanks">
					<span className="aoq-ok">✓</span>
					{thanks}
				</div>
			</div>
		);
	}
	if (!survey) return null;

	const toggle = (choice: string) =>
		setPicked((p) => (p.includes(choice) ? p.filter((c) => c !== choice) : [...p, choice]));

	return (
		<div className="aoq" role="dialog" aria-label="Quick question">
			<div className="aoq-hd">
				<span className="aoq-dot" aria-hidden />
				<span className="aoq-eye">Quick question</span>
				<button
					type="button"
					className="aoq-x"
					aria-label="Dismiss"
					onClick={() => finish("No problem", () => dismissCurrentSurvey())}
				>
					×
				</button>
			</div>
			<p className="aoq-q">{survey.question}</p>

			{survey.input === "text" ? (
				<>
					<textarea
						className="aoq-ta"
						placeholder={survey.placeholder}
						value={text}
						onChange={(e) => setText(e.target.value)}
					/>
					<div className="aoq-row">
						<button
							type="button"
							className="aoq-send"
							onClick={() => finish("Thanks — got it", () => answerCurrentSurvey(text.trim() || "(empty)"))}
						>
							Send
						</button>
						<button type="button" className="aoq-skip" onClick={() => finish("No problem", () => dismissCurrentSurvey())}>
							Skip
						</button>
					</div>
				</>
			) : (
				<>
					<div className="aoq-opts">
						{(survey.choices ?? []).map((choice) => {
							const sel = picked.includes(choice);
							return (
								<button
									key={choice}
									type="button"
									className={sel ? "aoq-opt sel" : "aoq-opt"}
									onClick={() =>
										survey.input === "multi"
											? toggle(choice)
											: finish("Thanks — noted", () => answerCurrentSurvey(choice))
									}
								>
									{choice}
								</button>
							);
						})}
					</div>
					{survey.input === "multi" ? (
						<div className="aoq-row">
							<button
								type="button"
								className="aoq-send"
								onClick={() => finish("Thanks — noted", () => answerCurrentSurvey(picked))}
							>
								Done
							</button>
						</div>
					) : (
						<div className="aoq-foot">One tap · helps us improve AO</div>
					)}
				</>
			)}
		</div>
	);
}
