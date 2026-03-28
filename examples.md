# Phantom Canvas — Usage Examples

## Setup

```bash
bun install -g github:baixianger/phantom-canvas
phantom-canvas login   # first time: login to Google
phantom-canvas         # start server on :8420
```

---

## 1. Text-to-Image

Generate an image from a text prompt. Each request starts a new Gemini conversation.

```bash
# Submit
curl -X POST localhost:8420/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Isometric pixel art knight with sword and shield, Final Fantasy Tactics style, on solid green #00FF00 chroma-key background, standing idle pose"
  }'
# => {"task_id": "abc123", "status": "queued"}

# Poll status
curl localhost:8420/task/abc123
# => {"status": "completed", "conversation_id": "05695dfd143c4dad", "images": [...]}

# Download image
curl localhost:8420/task/abc123/image/0 -o knight.png
```

---

## 2. Image-to-Image (Reference Upload)

Upload a reference image so Gemini keeps the same character design.

```bash
# Generate anchor sprite first
curl -X POST localhost:8420/generate \
  -d '{"prompt": "SE-facing isometric pixel art pirate, red bandana, blue tunic, FFT style, #00FF00 bg"}'
# Wait, download → pirate.png

# Use it as reference for 4-direction sheet
curl -X POST localhost:8420/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Using the uploaded character, create a 2x2 sprite sheet: top-left=North (back), top-right=East (right side), bottom-left=South (front), bottom-right=SE (same as ref). Same pixel art style, same green #00FF00 background.",
    "reference_images": ["/absolute/path/to/pirate.png"]
  }'
```

> `reference_images` must be **absolute local file paths**. The browser uploads them through Gemini's file upload UI.

---

## 3. Multi-Turn Conversation

Continue in the same Gemini chat to iterate on a design. Pass `conversation_id` from a previous task.

```bash
# Step 1: initial generation
curl -X POST localhost:8420/generate \
  -d '{"prompt": "Pixel art knight character, isometric, green background"}'
# => {"task_id": "aaa", "status": "queued"}

# Get conversation_id from result
curl localhost:8420/task/aaa
# => {"conversation_id": "05695dfd143c4dad", "images": [...]}

# Step 2: refine in same conversation — Gemini remembers context
curl -X POST localhost:8420/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Now make the sword larger and add a red cape",
    "conversation_id": "05695dfd143c4dad"
  }'

# Step 3: generate variations
curl -X POST localhost:8420/generate \
  -d '{
    "prompt": "Show this character from 4 different angles in a 2x2 grid",
    "conversation_id": "05695dfd143c4dad"
  }'
```

> Multi-turn is useful for iterative design. Gemini keeps the visual context from previous messages.

---

## 4. Video Generation

Generate walk cycle animations. Takes 1-2 minutes. Gemini has daily video quotas.

```bash
curl -X POST localhost:8420/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Short looping video of a pixel art knight walking in place, isometric view, Final Fantasy Tactics style",
    "type": "video",
    "timeout_secs": 300
  }'
```

With reference image:

```bash
curl -X POST localhost:8420/generate \
  -d '{
    "prompt": "Looping walk cycle animation of this exact character",
    "reference_images": ["/path/to/knight.png"],
    "type": "video",
    "timeout_secs": 300
  }'
```

---

## 5. Webhook Callback

Get notified when generation completes instead of polling.

```bash
curl -X POST localhost:8420/generate \
  -d '{
    "prompt": "pixel art mage with staff, isometric, green bg",
    "callback_url": "http://localhost:3000/webhook"
  }'
```

Your webhook receives:

```json
{
  "task_id": "abc123",
  "status": "completed",
  "images": [{"index": 0, "url": "/task/abc123/image/0"}]
}
```

---

## 6. Full Pipeline — Game Asset Turnaround

Complete workflow for generating an 8-way isometric sprite sheet:

```bash
API=http://localhost:8420
OUT=./sprites

# Stage 1: Anchor sprite
TASK=$(curl -s -X POST $API/generate -d '{
  "prompt": "Single SE-facing isometric pixel art knight, dark armor, red cape, sword and shield, FFT style, solid #00FF00 green background, no shadow"
}' | jq -r .task_id)

echo "Stage 1: $TASK"
while [ "$(curl -s $API/task/$TASK | jq -r .status)" = "running" ]; do sleep 10; done
curl -s $API/task/$TASK/image/0 -o $OUT/anchor.png
CONV=$(curl -s $API/task/$TASK | jq -r .conversation_id)
echo "Anchor saved. Conversation: $CONV"

# Stage 2: Cardinal facings (multi-turn, Gemini remembers the knight)
TASK=$(curl -s -X POST $API/generate -d "{
  \"prompt\": \"Now create a 2x2 sprite sheet of this SAME knight from 4 angles: top-left=North (back view), top-right=East (right side), bottom-left=South (front view), bottom-right=SE (same as before). Same style, same green background.\",
  \"conversation_id\": \"$CONV\"
}" | jq -r .task_id)

echo "Stage 2: $TASK"
while [ "$(curl -s $API/task/$TASK | jq -r .status)" = "running" ]; do sleep 10; done
curl -s $API/task/$TASK/image/0 -o $OUT/cardinals.png

# Stage 3: Diagonal facings
TASK=$(curl -s -X POST $API/generate -d "{
  \"prompt\": \"Now create 4 diagonal views in a 2x2 grid: NW (mostly back + left side), NE (mostly back + right side), SW (mostly front + left side), SE (mostly front + right side). Same character, same style.\",
  \"conversation_id\": \"$CONV\"
}" | jq -r .task_id)

echo "Stage 3: $TASK"
while [ "$(curl -s $API/task/$TASK | jq -r .status)" = "running" ]; do sleep 10; done
curl -s $API/task/$TASK/image/0 -o $OUT/diagonals.png

# Stage 4: Assembly (local code, no API needed)
# python3 assemble.py $OUT/cardinals.png $OUT/diagonals.png $OUT/turnaround.png

# Stage 5: Walk animation
TASK=$(curl -s -X POST $API/generate -d "{
  \"prompt\": \"Create a short looping walk cycle video of this knight, isometric SW-facing, walking in place\",
  \"conversation_id\": \"$CONV\",
  \"type\": \"video\",
  \"timeout_secs\": 300
}" | jq -r .task_id)

echo "Stage 5: $TASK"
while [ "$(curl -s $API/task/$TASK | jq -r .status)" != "completed" ]; do sleep 15; done
curl -s $API/task/$TASK/image/0 -o $OUT/walk.mp4

echo "Done! Files in $OUT/"
ls -la $OUT/
```

---

## 7. TypeScript/Bun Client

```typescript
const API = "http://localhost:8420";

async function generate(opts: {
  prompt: string;
  type?: "image" | "video";
  referenceImages?: string[];
  conversationId?: string;
}) {
  // Submit task
  const { task_id } = await fetch(`${API}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: opts.prompt,
      type: opts.type ?? "image",
      reference_images: opts.referenceImages,
      conversation_id: opts.conversationId,
    }),
  }).then((r) => r.json());

  // Poll until done
  while (true) {
    const task = await fetch(`${API}/task/${task_id}`).then((r) => r.json());
    if (task.status === "completed") return task;
    if (task.status === "failed") throw new Error(task.error);
    await Bun.sleep(5000);
  }
}

// Usage
const anchor = await generate({
  prompt: "Isometric pixel art knight, FFT style, green #00FF00 bg",
});
console.log("Anchor:", anchor.images[0].url);

// Multi-turn: iterate on the same character
const refined = await generate({
  prompt: "Make the sword bigger and add a glowing effect",
  conversationId: anchor.conversation_id,
});

// Save image
const img = await fetch(`${API}${refined.images[0].url}`);
await Bun.write("knight.png", img);
```

---

## 8. Python Client

```python
import requests, time

API = "http://localhost:8420"

def generate(prompt, type="image", reference_images=None, conversation_id=None, timeout=180):
    """Submit generation task and wait for result."""
    resp = requests.post(f"{API}/generate", json={
        "prompt": prompt,
        "type": type,
        "reference_images": reference_images,
        "conversation_id": conversation_id,
        "timeout_secs": timeout,
    })
    task_id = resp.json()["task_id"]

    while True:
        task = requests.get(f"{API}/task/{task_id}").json()
        if task["status"] == "completed":
            return task
        if task["status"] == "failed":
            raise RuntimeError(task["error"])
        time.sleep(5)

def download(task, index=0, path="output.png"):
    """Download generated file."""
    url = f"{API}{task['images'][index]['url']}"
    with open(path, "wb") as f:
        f.write(requests.get(url).content)

# Text-to-image
result = generate("pixel art knight, isometric, green bg")
download(result, path="knight.png")

# Multi-turn
result2 = generate(
    "Now show 4 directions in a 2x2 grid",
    conversation_id=result["conversation_id"]
)
download(result2, path="directions.png")

# Video
video = generate(
    "Walk cycle animation of this knight",
    type="video",
    conversation_id=result["conversation_id"],
    timeout=300
)
download(video, path="walk.mp4")
```
