#!/usr/bin/env python3
"""Export original Sonic/object effects as short WAVs with validated metadata."""
import argparse
import json
import re
import wave
from pathlib import Path
from disc import Disc
from prepare_stage import ROOT, OUTPUT, Library
from prepare_menu import run

REQUESTS = {
    'ring': ('se_object_common.csb',4), 'superring': ('se_object_common.csb',23),
    'goal': ('se_object_common.csb',86), 'jump': ('se_player_sonic.csb',87),
    'boost': ('se_player_sonic.csb',90), 'land': ('se_player_sonic.csb',52),
    'spring': ('se_object_common_sonic.csb',1), 'dashpanel': ('se_object_common_sonic.csb',4),
    'jumpboard': ('se_object_common_sonic.csb',8),
    'checkpoint': ('se_object_common.csb',85),
    'defeat': ('se_object_common.csb',84),
}


def build(iso):
    disc=Disc(iso)
    library=Library(disc, {'sonic':disc.open_archive('Sonic'), 'system':disc.open_archive('SystemCommon'),
                          'objects':disc.open_archive('SonicActionCommon')})
    output=OUTPUT/'sfx';output.mkdir(exist_ok=True)
    private=ROOT/'private/audio';private.mkdir(parents=True,exist_ok=True)
    decoder=ROOT/'build/tools/vgmstream-build/cli/vgmstream-cli';manifest={}
    for name,(bank,index) in REQUESTS.items():
        source=private/bank
        if not source.exists():source.write_bytes(library.payload(bank))
        info=run([decoder,'-m','-s',index,source])
        samples=int(re.search(r'stream total samples: (\d+)',info)[1])
        hz=int(re.search(r'sample rate: (\d+)',info)[1])
        target=output/(name+'.wav');run([decoder,'-i','-s',index,'-o',target,source])
        with wave.open(str(target)) as w:
            if w.getnframes()!=samples or w.getframerate()!=hz:raise ValueError('Effect decode mismatch: '+name)
        manifest[name]={'url':target.relative_to(ROOT/'dist/probe').as_posix(),'samples':samples,'sample_rate':hz,
                        'source':bank,'subsong':index,'stream':re.search(r'stream name: (.*)',info)[1]}
    (output/'manifest.json').write_text(json.dumps(manifest,indent=2));print(f'Prepared {len(manifest)} original gameplay effects.')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('iso',type=Path);build(parser.parse_args().iso)
