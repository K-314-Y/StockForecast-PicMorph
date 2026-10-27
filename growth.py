"""Local tutorial progression and equipment. No prices, profit or real funds become XP.

XP rewards unique tutorial achievements and is strictly capped. Equipment
changes simulated parameter sensitivity, never a validated skill statistic.
"""
from __future__ import annotations

import json
import os
import tempfile
from dataclasses import replace
from pathlib import Path

from engine import Model, PLUGIN_IDS
from game import ROOT, SLOTS, parse_allocations

FILE = ROOT / "local_state" / "growth.json"
CHALLENGES = {
    "first_practice": {"name": "はじめての練習", "xp": 20},
    "diversify_slots": {"name": "2体以上に配分", "xp": 10},
    "full_allocation": {"name": "合計100%を配分", "xp": 10},
}
GEAR = (
    {"id":"none", "name":"装備なし", "icon":"·", "unlock_xp":0, "plugin":None, "bonus":0},
    {"id":"focus_lens", "name":"集中レンズ", "icon":"🔎", "unlock_xp":20, "plugin":"trend", "bonus":10},
    {"id":"spark_charm", "name":"ひらめきの飾り", "icon":"⚡", "unlock_xp":30, "plugin":"momentum", "bonus":15},
    {"id":"calm_halo", "name":"静寂の輪", "icon":"🛡️", "unlock_xp":40, "plugin":"volatility", "bonus":15},
)
GEAR_BY_ID = {g["id"]:g for g in GEAR}
MAX_XP = sum(c["xp"] for c in CHALLENGES.values())


def _empty():
    return {"schema":1, "revision":0, "slots":{
        key:{"achievements":[], "gear":"none"} for key in SLOTS
    }}


def read_growth():
    if not FILE.exists():
        return _empty()
    with FILE.open(encoding="utf-8") as handle:
        data=json.load(handle)
    if not isinstance(data,dict) or set(data)!={"schema","revision","slots"} or data["schema"]!=1:
        raise ValueError("育成記録の形式が不正です")
    if type(data["revision"]) is not int or data["revision"] < 0 or type(data["slots"]) is not dict or set(data["slots"])!=set(SLOTS):
        raise ValueError("育成記録のrevisionまたは枠が不正です")
    for slot in SLOTS:
        state=data["slots"][slot]
        if type(state) is not dict or set(state)!={"achievements","gear"}:
            raise ValueError("キャラの育成記録が不正です")
        achievements=state["achievements"]
        if type(achievements) is not list or any(type(k) is not str for k in achievements) or len(achievements)!=len(set(achievements)) or set(achievements)-set(CHALLENGES):
            raise ValueError("未知または重複した実績です")
        if type(state["gear"]) is not str or state["gear"] not in GEAR_BY_ID:
            raise ValueError("装備データが不正です")
        earned=sum(CHALLENGES[k]["xp"] for k in achievements)
        if earned < GEAR_BY_ID[state["gear"]]["unlock_xp"]:
            raise ValueError("未解放の装備が保存されています")
    return data


def xp_for(slot_state):
    return sum(CHALLENGES[k]["xp"] for k in slot_state["achievements"])


def level(xp):
    return 1 + int(xp>=20) + int(xp>=40)


def public_growth(record=None):
    if record is None:
        record=read_growth()
    result=[]
    for slot in SLOTS:
        value=record["slots"][slot]
        xp=xp_for(value)
        result.append({
            "slot":slot,"xp":xp,"level":level(xp),
            "achievements":list(value["achievements"]),
            "gear":value["gear"],
            "gear_options":[{**g,"unlocked":xp>=g["unlock_xp"]} for g in GEAR],
        })
    return {"revision":record["revision"],"slots":result,
            "challenges":[{"id":key,**v} for key,v in CHALLENGES.items()],
            "notice":"XPは各練習課題につき一度だけ。利益・予測精度では増えません。"}


def _save(record):
    FILE.parent.mkdir(parents=True,exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix=".growth-",dir=FILE.parent)
    try:
        with os.fdopen(fd,"w",encoding="utf-8") as handle:
            json.dump(record,handle,ensure_ascii=False,indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp,FILE)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _expect_revision(record,expected_revision):
    if type(expected_revision) is not int or expected_revision!=record["revision"]:
        raise LookupError("growth revision conflict: 育成状態を読み直してください")


def complete_training(proposed, expected_revision):
    allocations=parse_allocations(proposed)
    if not any(allocations.values()):
        raise ValueError("コインを配分してください")
    record=read_growth()
    _expect_revision(record,expected_revision)
    slots_with_coins=[k for k in SLOTS if allocations[k]>0]
    achievements=["first_practice"]
    if len(slots_with_coins)>=2:
        achievements.append("diversify_slots")
    if sum(allocations.values())==100:
        achievements.append("full_allocation")
    gained={}
    modified=False
    for slot in slots_with_coins:
        current=record["slots"][slot]["achievements"]
        new=[challenge for challenge in achievements if challenge not in current]
        current.extend(new)
        gained[slot]=sum(CHALLENGES[key]["xp"] for key in new)
        modified=modified or bool(new)
    if modified:
        record["revision"]+=1
        _save(record)
    return {"earned_xp":gained,"growth":public_growth(record)}


def equip(slot, gear_id, expected_revision):
    if type(slot) is not str or slot not in SLOTS or type(gear_id) is not str or gear_id not in GEAR_BY_ID:
        raise ValueError("キャラまたは装備IDが不正です")
    record=read_growth()
    _expect_revision(record,expected_revision)
    character=record["slots"][slot]
    if xp_for(character)<GEAR_BY_ID[gear_id]["unlock_xp"]:
        raise ValueError("装備はまだ解放されていません")
    if character["gear"] != gear_id:
        character["gear"]=gear_id
        record["revision"]+=1
        _save(record)
    return public_growth(record)


def equipped_models(base_models):
    """Return copies with in-game gear adjustments, never mutate saved models."""
    if type(base_models) is not dict or set(base_models)!=set(SLOTS):
        raise ValueError("育成対象のモデルが不足しています")
    record=read_growth()
    result={}
    for slot in SLOTS:
        model=base_models[slot]
        if not isinstance(model,Model):
            raise ValueError("予測モデルの形式が不正です")
        gear=GEAR_BY_ID[record["slots"][slot]["gear"]]
        if gear["plugin"] is None:
            result[slot]=model
            continue
        index=PLUGIN_IDS.index(gear["plugin"])
        strengths=list(model.plugin_strengths)
        strengths[index]=min(150,strengths[index]+gear["bonus"])
        result[slot]=replace(model,plugin_strengths=tuple(strengths))
    return result
