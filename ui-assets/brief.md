# herdr-fm27 brief

## 세계
- chiikawa-cards 에서는 할 수 있는 일(조작, 데이터, 단축키)만 가져옴. 보이는 요소(카드 띠, 장면, 레일, 캐릭터)는 가져오지 않음
- 화면은 FM27 문법: 상단 메뉴로 고르는 화면 네 개(Squad, Inbox, Staff, Club) + 그 아래 늘 있는 터미널
- 축구 요소 치환은 이름과 문법에만: 세션 표 = Squad, 계정 = Staff, 저장소와 공간 = Club, 부르는 세션과 리포트 = Inbox, 에이전트 종류 = 국적 표시
- 캐릭터 없음. 세션의 정체는 티켓 키, 에이전트 국적 표시, 상태 아이콘으로 구분
- 창: 사용자 창 1680 x 1860 세로형

```
┌ top 56: ◀▶ 문장+공간 스위처 | SQUAD INBOX STAFF CLUB | Search 리포트 설정 | 날짜·시계 | Continue »
├ sub 38: 화면별 하위 탭 | 되돌리기 알림, Keys
├ screen 760: 고른 화면 (Squad 는 세션 표 + 선택 세션 개요)
└ live: 탭 막대 + pane 헤더 + 터미널
```

## mod 구성
| mod | 맡는 기능 |
|---|---|
| fm-chrome | 화면 전환 메뉴, 공간 스위처, 방문 기록, 검색, Continue, 리포트 배지, 되돌리기, 키 안내 |
| fm-screens | Squad, Inbox, Staff, Club 화면. 키보드를 쥠 |
| fm-live | 탭 막대, Files·Changes 패널, pane 헤더 |
| fm-editor | hv 에디터 pane |

## 경위
- 1차 시안(chiikawa 슬롯을 FM 화면에 1:1 매핑), 2차 시안(치이카와 얼굴과 세로 피치 사용)은 폐기함(2026-11-11 사용자 지적)

## 캐릭터
- 사용하지 않음

## 분위기와 화풍 (레퍼런스 영상 mzKBI0o5eek, 사용자 캡처 2장)
- 바이올렛 블랙 바탕에 대각선 보라·자홍 빛줄기, 남색 상단 바, 자홍 Continue
- 패널: 둥근 모서리 6px, 컨덴스드 대문자 제목, 표는 줄무늬와 왼쪽 색 막대
- 대회 컬럼마다 헤더 색 띠(빨강, 초록, 보라)와 Objective/Status 두 줄

## 생성 방식, 범위
- 에셋: Gemini(aside repl) 생성, 프롬프트는 `ui-assets/prompts/`, 원본은 `ui-assets/raw/`
- 1단계 범위: 시안(`design/index.html`, `design/shots/fm27-window.png`)
- 2단계 범위: mod 구현(아래 「구현 (2026-11-11)」 절)

## 2026-11-11 다듬기 (v3.1)

- 선택 표시 규칙: FM 처럼 테두리 없이 밝아진 배경 띠와 왼쪽 노란 막대 하나로 표시하고, 티켓 키는 노란색으로 바뀜. Squad, Inbox, Club 모두 같은 표시를 쓰고 마우스는 옅은 배경만 바뀜. v3.1 의 노란 링(네 변 테두리)은 실제 FM 에 없는 표시이고 왼쪽 막대와 겹쳐 어색하다는 지적을 받아 v3.2 에서 뺐음
- 용어를 축구 전술 용어로 바꿈: Touchline(부르는 세션), Stoppage(멈춘 세션), In possession(작업 중), Full time(끝난 세션), Shape 3-4-8(상태별 세션 수), Phase(회차), Mins와 Added time(경과 시간과 남은 시간), Game plan(계획), Commentary(최근 메시지), Watch live(세션으로 이동), Dossier(링크 메뉴), Match report(리포트), Sub off(숨기기), Transfer(계정 전환), Backroom staff와 wage budget(계정과 사용량), Nat(에이전트 종류), Scout(검색)
- 표면 다듬기: 패널 모서리 10px, 위쪽 하이라이트, 표의 가로줄을 없애고 여백과 줄무늬로 행을 구분, 모든 컨트롤에 같은 전환 곡선 적용, 한글 글꼴은 Pretendard 로 통일

## 구현 (2026-11-11)

- mod 6개: fm-squad(Squad 표·Overview·Inbox, 세션 스캔), fm-chrome(상단 바·하위 바·Keys 팝업, 단축키 전달), fm-staff(계정·사용량), fm-club(스페이스와 전환 오버레이), fm-live(탭 줄·패널 머리), fm-editor(hv, hv-open)
- 화면 전환: `screens` 스택의 squad/inbox/staff/club 자식을 `layout.select` 로 바꿈. 숨은 자식은 그려지지 않아 키를 못 받으므로 단축키는 fm-chrome 상단 역할이 받아 `fm.cmd` 로 fm-squad 에 넘김
- 시안과 다른 점: 색 전환은 즉시 바뀜(gpui-kit 애니메이션이 투명도·크기·위치만 지원), 패널 도구는 항상 보임, Staff·Club 하위 탭과 staff 의 chip/rail 역할은 뺐음
- 첫 화면: fm-squad 가 마지막 스캔 결과를 localStorage `fm27.lastScan` 에 30분 동안 보관했다가 시작할 때 복원함
- 설치: `tools/install.sh` 가 `${HERDR_APP_HOME:-~/.config/herdr-app}` 에 mod·레이아웃·테마를 복사하고 keys.json 을 백업한 뒤 `layout:fm27` 절을 병합함
- 검수: 별도 인스턴스(`HC_SESSION=fmqa HERDR_APP_HOME=/tmp/fmqa`)에서 확인함. 최소화하거나 화면 밖에 둔 창은 처음 몇 프레임 뒤 멈추므로 창을 화면 오른쪽 끝 3px 에 두고 캡처마다 다시 띄움. 이 환경에서는 기본 레이아웃도 스페이스 목록이 「Loading…」 에 멈추고 터미널이 비어 보임
