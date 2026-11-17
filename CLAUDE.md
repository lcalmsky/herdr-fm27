# herdr-fm27 작업 규칙

## 미리보기 규칙 (herdr-* 저장소 공통)

이 절은 `~/git-repo/herdr-*` 저장소가 똑같이 싣는다. 한 곳에서 고치면 나머지 저장소의 같은 절도 같이 고친다.

- **레이아웃 선택 화면 그림.** 레이아웃이 있는 저장소는 `layouts/<name>.json` 루트에 `"preview": "layouts/<name>.png"` 를 두고 `layouts/<name>.png`(640×400)를 저장소에 싣는다. 필드나 그림 중 하나라도 없으면 Herdr 설정 화면에 빈 틀이 나온다 (`~/.config/herdr-app/AGENTS.md` 의 `preview` 항목).
- **설치는 JSON 과 PNG 를 같이 옮긴다.** 설치 스크립트와 README 의 복사 명령이 둘 다 옮기는지 확인한다. 설치본(`~/.config/herdr-app/layouts/`)에만 필드나 그림을 넣지 않는다. 다음 설치가 JSON 을 통째로 덮어써서 필드가 사라진다.
- **갤러리 그림.** herdr.dev 갤러리는 저장소 루트의 `preview.png` 를 보여 준다. 16:10(예: 2560×1600)으로 만들고, 선택 화면 그림은 같은 화면을 640×400 으로 줄여 쓴다.
- **공개되는 그림에는 지어낸 데모 데이터만 쓴다.** `preview.png`, `layouts/*.png`, README·docs 의 스크린샷과 GIF 가 대상이다. 화면 속 글은 전부 영어로 하고, 회사 업무가 드러나는 것이 보이지 않아야 한다: 티켓 키, 사내 저장소·서비스·채널 이름, 고객과 동료 이름, 실제 터미널 내용, 홈 경로의 계정 이름. 실제로 쓰는 창을 그대로 찍은 그림은 싣지 않는다.
- **모양을 바꾸면 같은 커밋에서 두 그림을 다시 만든다.** 커밋하기 전에 그림을 열어 위 항목을 눈으로 확인한다.

## 공유 파일 (herdr-shared)

`mods/fm-staff/` 의 `cca`, `usage-tap.sh`, `usage-api.mjs`, `codex-usage.mjs`, `models.mjs`,
`mods/fm-squad/scan.sh`, `mods/fm-editor/` 의 `hv`, `hv-open`, `tools/merge-keys.py`,
`tools/herdr-open/` 의 세 파일은 `~/git-repo/herdr-shared` 에서 온 사본이다. 이 저장소에서
손으로 고치지 않는다. 고칠 것이 있으면 herdr-shared 에서 고치고 다시 vendor 한다.

```sh
~/git-repo/herdr-shared/tools/vendor.sh \
  accounts mods/fm-staff scan mods/fm-squad editor mods/fm-editor \
  herdr-open tools/herdr-open merge-keys tools
```

`tests/shared-vendor.test.mjs` 가 사본이 원본과 같은지 확인한다 (herdr-shared 가 없으면 건너뛴다).
