"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import styles from "./mediation-room.module.css";

type MediationRoomProps = {
  roomId: string;
  nodeId: string;
  topic: string;
  summary: string;
  initialContention: number;
  initialReadiness: number;
  discussionLoopCount: number;
  fromReplay: boolean;
  triggerAt?: number;
  resumeAt?: number;
};

type MediationScenario = {
  participants: [
    { name: string; initials: string; role: string; concern: string },
    { name: string; initials: string; role: string; concern: string },
  ];
  commonGround: string;
  nextStep: string;
};

const PHASE_LENGTHS = [2800, 3200, 3200];
function formatTime(milliseconds: number) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function getScenario(topic: string): MediationScenario {
  if (topic.toLowerCase().includes("clipboard")) {
    return {
      participants: [
        {
          name: "Chelsea Rathbun",
          initials: "CR",
          role: "Product lead",
          concern:
            "Choosing the clipboard scope without usability evidence could create a confusing workflow.",
        },
        {
          name: "Jenna Makowski",
          initials: "JM",
          role: "Design lead",
          concern:
            "Committing to multiple items too early may increase first-phase complexity and delay learning.",
        },
      ],
      commonGround:
        "Both participants want evidence before committing engineering effort. Prototype one-item and multi-item behavior, then use usability findings to choose the final scope.",
      nextStep: "Add both interaction models to the first design and research phase.",
    };
  }

  return {
    participants: [
      {
        name: "Chelsea Rathbun",
        initials: "CR",
        role: "Product lead",
        concern:
          "Approved proposals need clearer ownership so the board does not imply delivery is already staffed.",
      },
      {
        name: "Jenna Makowski",
        initials: "JM",
        role: "Roadmap owner",
        concern:
          "Adding more status labels may make the roadmap harder for non-technical contributors to understand.",
      },
    ],
    commonGround:
      "Use one plain-language approval status and show resourcing as a separate ownership indicator.",
    nextStep: "Validate the wording with people who regularly use the proposal board.",
  };
}

function completedMediationsStorageKey(roomId: string) {
  return `conflict-mitigator:completed-mediations:${roomId}`;
}

export default function MediationRoom({
  roomId,
  nodeId,
  topic,
  summary,
  initialContention,
  initialReadiness,
  discussionLoopCount,
  fromReplay,
  triggerAt,
  resumeAt,
}: MediationRoomProps) {
  const router = useRouter();
  const scenario = useMemo(() => getScenario(topic), [topic]);
  const [phase, setPhase] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const resolvedReadiness = phase === 3 ? 0.88 : Math.max(initialReadiness, 0.22 + phase * 0.2);

  const meetingHref = fromReplay && triggerAt !== undefined
    ? `/room/${encodeURIComponent(roomId)}?replayAt=${triggerAt}`
    : `/room/${encodeURIComponent(roomId)}`;
  const completedMeetingHref = fromReplay && resumeAt !== undefined
    ? `/room/${encodeURIComponent(roomId)}?replayAt=${resumeAt}&resume=1&mediated=${encodeURIComponent(nodeId)}`
    : `/room/${encodeURIComponent(roomId)}`;

  useEffect(() => {
    if (phase >= 3) return;
    const timer = window.setTimeout(
      () => setPhase((current) => Math.min(3, current + 1)),
      PHASE_LENGTHS[phase],
    );
    return () => window.clearTimeout(timer);
  }, [phase]);

  const phaseCopy = [
    {
      eyebrow: "Listening to your perspective",
      title: "You’re speaking privately",
      detail: "Your Private Agent is identifying the concern underneath your position.",
    },
    {
      eyebrow: "Agent reflection",
      title: "The agent is clarifying what matters",
      detail: "Only structured concerns—not your exact words—move to the comparison step.",
    },
    {
      eyebrow: "Comparing concerns",
      title: "Private Agents are checking alignment",
      detail: "The system is looking for a solution that respects both participants’ priorities.",
    },
    {
      eyebrow: "Common ground found",
      title: "You’re ready to rejoin the meeting",
      detail: "The agreed summary is ready to share. Private voice content stays private.",
    },
  ][phase];

  const returnToMeeting = () => {
    try {
      const stored = window.sessionStorage.getItem(
        completedMediationsStorageKey(roomId),
      );
      const completedNodeIds = new Set<string>(
        stored ? (JSON.parse(stored) as string[]) : [],
      );
      completedNodeIds.add(nodeId);
      window.sessionStorage.setItem(
        completedMediationsStorageKey(roomId),
        JSON.stringify(Array.from(completedNodeIds)),
      );
    } catch {
      // The return URL also carries the completed node for the demo state.
    }
    router.push(completedMeetingHref);
  };

  return (
    <div className={styles.roomShell}>
      <header className={styles.roomHeader}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>CM</span>
          <span>
            <strong>Private Mediation</strong>
            <small>Voice session · AI guided</small>
          </span>
        </div>
        <div className={styles.topicBreadcrumb}>
          <span>Child topic</span>
          <strong>{topic}</strong>
        </div>
        <Link href={meetingHref} className={styles.exitLink}>Exit private room</Link>
      </header>

      <div className={styles.privacyBanner} role="note">
        <span className={styles.lockIcon} aria-hidden="true">◇</span>
        <p>
          <strong>This voice conversation is private.</strong>
          Audio and raw speech stay between you and your Private Agent. Only structured concerns and agreed common ground are shared.
        </p>
        <span className={styles.privateBadge}>Encrypted voice</span>
      </div>

      <main className={styles.mediationBody}>
        <aside className={styles.contextPanel}>
          <div className={styles.contextEyebrow}>Mediation topic</div>
          <h1>{topic}</h1>
          <p>{summary}</p>

          <div className={styles.signalCard}>
            <div>
              <span>Contention detected</span>
              <strong>{Math.round(initialContention * 100)}%</strong>
            </div>
            <div className={styles.meter}>
              <i style={{ width: `${Math.round(initialContention * 100)}%` }} />
            </div>
            <small>Above the 70% threshold · {discussionLoopCount} repeated loops</small>
          </div>

          <div className={styles.sessionTimeline}>
            {["Private voice", "Clarify concerns", "Compare", "Common ground"].map((label, index) => (
              <div key={label} className={index < phase ? styles.stepDone : index === phase ? styles.stepActive : ""}>
                <i>{index < phase ? "✓" : index + 1}</i>
                <span>{label}</span>
              </div>
            ))}
          </div>

          <div className={styles.readinessCard}>
            <div><span>Readiness to resume</span><strong>{Math.round(resolvedReadiness * 100)}%</strong></div>
            <div className={styles.readinessMeter}><i style={{ width: `${resolvedReadiness * 100}%` }} /></div>
          </div>
        </aside>

        <section className={styles.voicePanel} aria-label="Private voice mediation">
          <header className={styles.voiceHeader}>
            <div><i /> Private voice channel</div>
            <span>{triggerAt !== undefined ? `Meeting paused at ${formatTime(triggerAt)}` : "Live mediation"}</span>
          </header>

          <div className={styles.voiceStage}>
            <div className={styles.phaseCopy} aria-live="polite">
              <span>{phaseCopy.eyebrow}</span>
              <h2>{phaseCopy.title}</h2>
              <p>{phaseCopy.detail}</p>
            </div>

            <div className={styles.voiceConnection}>
              <div className={`${styles.voicePerson} ${phase % 2 === 0 && phase < 3 ? styles.isSpeaking : ""}`}>
                <div className={styles.voiceOrb}><span>CR</span><i /><i /><i /></div>
                <strong>You</strong>
                <small>{phase % 2 === 0 && phase < 3 ? "Speaking" : "Listening"}</small>
              </div>

              <div className={styles.waveform} aria-hidden="true">
                {Array.from({ length: 23 }, (_, index) => <i key={index} style={{ animationDelay: `${index * -55}ms` }} />)}
              </div>

              <div className={`${styles.voicePerson} ${phase % 2 === 1 && phase < 3 ? styles.isSpeaking : ""}`}>
                <div className={`${styles.voiceOrb} ${styles.agentOrb}`}><span>✦</span><i /><i /><i /></div>
                <strong>Private Agent</strong>
                <small>{phase % 2 === 1 && phase < 3 ? "Speaking" : phase === 3 ? "Complete" : "Listening"}</small>
              </div>
            </div>

            <div className={styles.voiceControls}>
              <button
                className={isMuted ? styles.controlMuted : ""}
                onClick={() => setIsMuted((current) => !current)}
                aria-pressed={isMuted}
              >
                <span>{isMuted ? "×" : "♩"}</span>
                {isMuted ? "Unmute" : "Mute"}
              </button>
              <div className={styles.liveWave} aria-hidden="true"><i /><i /><i /><i /><i /></div>
              <span>{isMuted ? "Microphone muted" : "Microphone active"}</span>
            </div>
          </div>
        </section>

        <aside className={styles.outcomePanel} aria-label="Participant concerns and common ground">
          <header>
            <span>Structured outcome</span>
            <strong>{phase < 3 ? "Finding alignment…" : "Ready to share"}</strong>
          </header>

          <div className={styles.concernGrid}>
            {scenario.participants.map((participant, index) => (
              <section
                key={participant.name}
                className={`${styles.concernBlock} ${phase >= index + 1 ? styles.blockRevealed : ""}`}
              >
                <div className={styles.participantTitle}>
                  <span>{participant.initials}</span>
                  <div><strong>{participant.name}</strong><small>{participant.role}</small></div>
                </div>
                <div className={styles.blockLabel}>Primary concern</div>
                <p>{phase >= index + 1 ? participant.concern : "Private Agent is still clarifying this concern…"}</p>
              </section>
            ))}
          </div>

          <section className={`${styles.commonGroundBlock} ${phase === 3 ? styles.commonGroundRevealed : ""}`}>
            <div className={styles.commonGroundHeading}>
              <span>✓</span>
              <div><small>Common ground</small><strong>{phase === 3 ? "Agreement found" : "Comparing concerns"}</strong></div>
            </div>
            {phase === 3 ? (
              <>
                <p>{scenario.commonGround}</p>
                <div className={styles.nextStep}><span>Next step</span><strong>{scenario.nextStep}</strong></div>
                <button onClick={returnToMeeting}>
                  Return to meeting <span>→</span>
                </button>
              </>
            ) : (
              <div className={styles.searchingState}><i /><span>The agents are looking for an overlap between both concerns.</span></div>
            )}
          </section>
        </aside>
      </main>
    </div>
  );
}
