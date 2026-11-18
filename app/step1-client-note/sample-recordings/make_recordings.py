#!/usr/bin/env python3
"""Builds the sample recordings for the five ReintegrAIt test cases.
Needs: espeak-ng and ffmpeg on PATH.   Run: python3 make_recordings.py
Voices are synthetic (espeak-ng), so they sound robotic; the words, order and
the noise/crosstalk/inaudible stretches are what the test cases need."""
import subprocess, tempfile, os, wave, json, random, struct, math

RATE = 22050
VOICE = {  # name: (espeak voice, speed wpm, pitch)
    "Denise": ("en-us+f3", 150, 55),
    "Andre":  ("en-us+m3", 140, 35),
    "Cousin": ("en-us+m7", 165, 60),
    "Clinic": ("en-us+f4", 155, 60),
}
tmp = tempfile.mkdtemp()

def say(who, text, n=[0]):
    v, wpm, pitch = VOICE[who]
    n[0] += 1
    raw = f"{tmp}/{n[0]}.wav"
    subprocess.run(["espeak-ng", "-v", v, "-s", str(wpm), "-p", str(pitch), "-w", raw, text], check=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", raw, "-ar", str(RATE), "-ac", "1", f"{raw}.n.wav"], check=True)
    return read(f"{raw}.n.wav")

def read(p):
    with wave.open(p) as w:
        d = w.readframes(w.getnframes())
    return list(struct.unpack("<%dh" % (len(d)//2), d))

def silence(sec): return [0]*int(RATE*sec)

def noise(n, amp):
    return [int(random.gauss(0, amp)) for _ in range(n)]

def mix(a, b, offset=0, gain=1.0):
    out = a + [0]*max(0, offset+len(b)-len(a))
    for i, s in enumerate(b):
        out[offset+i] = max(-32768, min(32767, out[offset+i] + int(s*gain)))
    return out

def write(samples, path):
    wav = f"{tmp}/out.wav"
    with wave.open(wav, "w") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
        w.writeframes(struct.pack("<%dh" % len(samples), *samples))
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-b:a", "48k", path], check=True)

def conversation(lines, room=60, gap=0.6):
    """lines: (who, text). Returns audio and a list of (seconds, who, text)."""
    audio, log, t = [], [], 0.0
    for who, text in lines:
        s = say(who, text)
        log.append((t, who, text))
        audio += s + silence(gap)
        t += (len(s)/RATE) + gap
    return mix(audio, noise(len(audio), room)), log

def hms(s): s = int(s); return f"{s//3600:02d}:{s%3600//60:02d}:{s%60:02d}"

def save(name, audio, log, title, note):
    write(audio, f"{name}.mp3")
    with open(f"{name}.transcript.txt", "w") as f:
        f.write(f"{title}\n{note}\n\n")
        for t, who, text in log:
            f.write(f"[{hms(t)}] {who}: {text}\n")
    print(name, hms(len(audio)/RATE))

random.seed(7)

# ---- Cases 1 and 4: intake, Wed Nov 11 (condensed; no gender stated, phone cut off) ----
intake = [
 ("Denise", "This is intake for Andre Williams, November eleventh."),
 ("Denise", "I'm recording so I don't have to write while we talk. Is that alright?"),
 ("Andre", "Yeah, that's fine."),
 ("Denise", "How old are you now?"),
 ("Andre", "Thirty-four. I turn thirty-five in March."),
 ("Denise", "Where are you staying?"),
 ("Andre", "I got out of Sheridan on the second. I'm staying with my cousin in Englewood, on the couch. He said two weeks, maybe three."),
 ("Denise", "Do you have any ID with you?"),
 ("Andre", "I don't have any ID. Just the release papers."),
 ("Denise", "Any health issues I should know about?"),
 ("Andre", "My blood pressure pills ran out Saturday. They only gave me two weeks' worth."),
 ("Denise", "Okay, that's urgent. What about work?"),
 ("Andre", "I want to work. I did forklift in there, I got the certificate."),
 ("Denise", "And are you getting any food benefits right now?"),
 ("Andre", "I'm not on food stamps or nothing."),
 ("Denise", "Are you still on supervised release?"),
 ("Andre", "Yeah, I see my P O on Tuesdays."),
 ("Denise", "And just to confirm, nothing on your record involving a sex offense?"),
 ("Andre", "No. Nothing like that."),
 ("Denise", "What's the best number to reach you?"),
 ("Andre", "It's my cousin's phone. Seven seven three, five five five, zero one"),   # cut off below
 ("Denise", "So this week we start your state ID application with your release papers, we find a clinic for a same-week refill, and I'll call you Friday, November thirteenth."),
 ("Andre", "Sounds good. Thank you."),
]
# render the phone line, then truncate the last digits into an inaudible gap
a, log = conversation(intake)
save("case1-4_intake_andre_nov11", a, log,
     "Cases 1 and 4: intake with Andre Williams, Wed Nov 11 (condensed ~2 min version of the 47-min recording)",
     "Never states gender. Phone is spoken only as 773-555-01 and ends there (last two digits never said). Nobody agrees to SNAP. Agreed steps: state ID, clinic refill, Friday Nov 13 call.")

# ---- Case 2: Andre reacts to the options (curfew) ----
c2 = [
 ("Denise", "Okay Andre, I found three housing options. Teamwork Englewood has openings this week and it's close to your cousin's place. There's also a men's transitional house, and a shelter."),
 ("Andre", "What's the shelter like?"),
 ("Denise", "It has a nine P M curfew."),
 ("Andre", "Nah. I won't stay anywhere with a curfew. Not doing that."),
 ("Denise", "Understood. I'll take that one off. Do I have your okay to share your information with Teamwork Englewood?"),
 ("Andre", "Yes, that's fine. You can share it with them."),
]
a, log = conversation(c2)
save("case2_housing_options_curfew", a, log,
     "Case 2: Andre hears the housing options and refuses the curfew shelter; agrees to share with Teamwork",
     "Use to trigger 'Not this one -> Client declined' and the consent tick. The ranking cards themselves come from the Step 2 UI.")

# ---- Case 3: noisy speakerphone update, Wed Nov 18 ----
tv = noise(RATE*100, 900)  # steady broadband 'TV' bed
def tvbed(n):  # slow-modulated noise so it sounds like a TV
    return [int(tv[i] * (0.6 + 0.4*math.sin(i/2500))) for i in range(n)]

def inaudible(sec):  # loud bursts of noise, no speech
    n = int(RATE*sec); return noise(n, 4500)

segments = [
 ("Denise", "Hi Andre, it's Denise, calling for your check-in. Can you hear me okay?"),
 ("Andre", "Yeah, I can hear you. Hold on, let me turn the TV down. Okay."),
 ("Denise", "How did the blood pressure pills work out?"),
 ("Andre", "Good news, I got my refill on Monday. I'm taking them again."),
 ("Cousin", "Yeah, he was out drinking Friday."),            # crosstalk, speaker unclear
 ("Denise", "Sorry, who was that talking?"),
 ("INAUDIBLE", 4),
 ("Andre", "Is Thursday's appointment with Teamwork still on? Ten o'clock?"),
 ("Denise", "Yes, Thursday, November nineteenth at ten, at Teamwork Englewood. Bring your release papers."),
 ("INAUDIBLE", 3),
 ("Andre", "Okay. I'll be there. Still on the couch, nothing new on housing yet."),
 ("Denise", "Alright. I'll check in again next week."),
]
voice, log, t = [], [], 0.0
for who, x in segments:
    if who == "INAUDIBLE":
        s = inaudible(x); log.append((t, "[inaudible]", f"~{x} sec"))
    else:
        s = say(who, x); log.append((t, who, x))
    voice += s + silence(0.5); t += len(s)/RATE + 0.5
# cousin interrupts over Andre's refill line: overlay cousin 1.2s into Andre's turn
audio = mix(voice, tvbed(len(voice)), 0, 1.0)
audio = mix(audio, say("Cousin", "Man, he was out drinking Friday, you know that."), int(RATE*13.0), 0.9)
save("case3_noisy_update_call_nov18", audio, log,
     "Case 3: speakerphone check-in Wed Nov 18 with TV noise, cousin crosstalk and two inaudible stretches",
     "Cousin says 'he was out drinking Friday' (speaker not Andre). Andre: refill got Monday; Thursday Teamwork appt still on; housing still open.")

# ---- Case 5: Denise phones Clinic #1 ----
c5 = [
 ("Clinic", "Community Health Clinic, how can I help you?"),
 ("Denise", "Hi, I'm a case manager calling for a client who needs a blood pressure refill this week. Do you have any openings?"),
 ("Clinic", "We're full until Monday."),
 ("Denise", "Do you take uninsured walk-ins?"),
 ("Clinic", "You'd have to call back Monday and ask about that."),
 ("Denise", "Okay, thank you."),
]
a, log = conversation(c5, room=80)
save("case5_clinic1_phone_call", a, log,
     "Case 5: Denise calls Clinic #1 and hears 'We're full until Monday'",
     "Use to trigger 'Not this one -> Full'. Walk-in rule stays unanswered. Medicaid is never discussed in this clip.")
