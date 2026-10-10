#!/bin/sh
# Downloads the sample articles (plain text, wiki heading markers stripped) into texts/.
set -e
cd "$(dirname "$0")"; mkdir -p texts
get() {
  curl -s "https://$1.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&format=json&titles=$2" |
    python3 -c "import json,sys,re; t=list(json.load(sys.stdin)['query']['pages'].values())[0]['extract']; print(re.sub(r'^=+ *(.*?) *=+$', r'\1', t, flags=re.M))" > "texts/$3.txt"
}
get de 'Drei%C3%9Figj%C3%A4hriger_Krieg' de-30jKrieg
get de Bundesverfassungsgericht de-BVerfG
get en Roman_Empire en-RomanEmpire
