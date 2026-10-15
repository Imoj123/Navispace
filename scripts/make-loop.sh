#!/usr/bin/env bash
# Turns a stock clip into a focus-mode scene: a seamless, silent 720p loop
# (the last 1.5 s crossfade into the first frames) plus a poster: the clip's
# first frame, shown the instant a scene is picked while the video loads.
#
#   scripts/make-loop.sh <input video> <scene key>
#   scripts/make-loop.sh ~/Downloads/koi.mp4 koi   ->  public/media/koi.mp4 + koi.webp
#
# Scene keys used by public/focus.html: rain, forest, ocean, stars, koi, study.
set -euo pipefail

in="$1"
key="$2"
out="$(dirname "$0")/../public/media"
fade=1.5
mkdir -p "$out"

dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$in")
offset=$(awk -v d="$dur" -v f="$fade" 'BEGIN { print d - 2 * f }')

ffmpeg -v error -y -i "$in" -filter_complex "\
[0:v]scale='if(gte(iw,ih),min(1280,iw),-2)':'if(gte(iw,ih),-2,min(1280,ih))',fps=25,split[a][b];\
[a]trim=0:$fade,setpts=PTS-STARTPTS[head];\
[b]trim=$fade:$dur,setpts=PTS-STARTPTS[body];\
[body][head]xfade=transition=fade:duration=$fade:offset=$offset,format=yuv420p[v]" \
  -map "[v]" -an -c:v libx264 -preset slow -crf 29 -profile:v high -movflags +faststart \
  "$out/$key.mp4"

ffmpeg -v error -y -i "$out/$key.mp4" -frames:v 1 -vf "scale='if(gte(iw,ih),960,-2)':'if(gte(iw,ih),-2,960)'" -c:v libwebp -quality 72 "$out/$key.webp"

ls -la "$out/$key.mp4" "$out/$key.webp"
