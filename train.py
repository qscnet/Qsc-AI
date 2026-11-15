#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
玄武 · 训练脚本（第一步：57 维特征 → 逻辑回归）

不需要 GPU，不需要 sklearn，只要 numpy。
从 samples.jsonl 读标注样本，学出每个特征的权重，导出 model.json。
服务端会自动加载 model.json，之后打分就走模型，不再用人工拍的权重。

用法：
    python train.py                 # 训练 + 5 折交叉验证 + 写 model.json
    python train.py --demo          # 用合成数据跑一遍，验证代码能不能跑通
    python train.py --cv 10         # 10 折交叉验证
    python train.py --l2 0.01       # 调正则强度
    python train.py --out my.json   # 换个输出文件名

样本格式（samples.jsonl，每行一条，服务端 /api/v1/feedback 自动写的）：
    {"label":"ai","features":{"rhythm_cv":0.41,"lex_redup":8.4,...}}
    {"label":"human","features":{...}}

安装依赖：
    pip install numpy
"""

import argparse
import json
import math
import os
import random
import sys
import time

try:
    import numpy as np
except ImportError:
    sys.exit("缺 numpy，先跑：pip install numpy")

# Windows 下重定向输出默认走 GBK，强制成 UTF-8，否则日志读不了
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = os.path.dirname(os.path.abspath(__file__))
SAMPLES = os.path.join(ROOT, "samples.jsonl")
OUT = os.path.join(ROOT, "model.json")

MIN_PER_CLASS = 10
MIN_COVER = 0.80   # 特征至少在 80% 样本里有值，否则均值不可靠
MIN_CV = 0.05      # 变异系数低于 5% 视为近似常量，会让 z 爆炸
Z_CLIP = 3.0       # 标准化后截断到 ±3，任何单项都不能主导结论


# ---------------------------------------------------------------- 数据


def load_samples(path):
    """读 samples.jsonl，返回 (特征名列表, X, y, 统计)"""
    if not os.path.exists(path):
        sys.exit(
            "\n  找不到 %s。\n\n"
            "  先攒样本：网页上检测完点 👍/👎，或调 POST /api/v1/feedback。\n"
            "  每类至少 %d 条才能训练。\n" % (path, MIN_PER_CLASS)
        )

    rows, bad = [], 0
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                s = json.loads(line)
            except Exception:
                bad += 1
                continue
            if s.get("label") not in ("ai", "human") or not isinstance(s.get("features"), dict):
                continue
            rows.append(s)

    n_ai = sum(1 for r in rows if r["label"] == "ai")
    n_hu = sum(1 for r in rows if r["label"] == "human")
    print("  样本：AI %d 条，人类 %d 条%s" % (n_ai, n_hu, ("（跳过损坏行 %d）" % bad) if bad else ""))

    if n_ai < MIN_PER_CLASS or n_hu < MIN_PER_CLASS:
        sys.exit("\n  样本不够：每类至少 %d 条。现在 AI %d / 人类 %d，继续标。\n"
                 % (MIN_PER_CLASS, n_ai, n_hu))

    # 特征筛选：覆盖率不足的不要（均值不可靠）
    counts = {}
    for r in rows:
        for k, v in r["features"].items():
            if isinstance(v, (int, float)):
                counts[k] = counts.get(k, 0) + 1
    cover = len(rows) * MIN_COVER
    # 语病类特征（gram_*）只服务「通顺度」，不进 AI 分。
    # 真人网文比 AI 文本更容易有语病，让它们参与打分会把校对良好的稿子判成 AI。
    low_cover = sorted([k for k, c in counts.items() if c < cover])
    feat_ids = sorted([k for k, c in counts.items() if c >= cover and not k.startswith("gram_")])
    if not feat_ids:
        sys.exit("\n  没有任何特征在 %d%% 以上样本里出现，数据可能有问题。\n" % int(MIN_COVER * 100))
    if low_cover:
        print("  丢弃覆盖率不足的特征（<%d%%）：%s" % (int(MIN_COVER * 100), "、".join(low_cover)))

    X = np.zeros((len(rows), len(feat_ids)), dtype=np.float64)
    y = np.zeros(len(rows), dtype=np.float64)
    for i, r in enumerate(rows):
        for j, fid in enumerate(feat_ids):
            v = r["features"].get(fid)
            X[i, j] = float(v) if isinstance(v, (int, float)) else np.nan
        y[i] = 1.0 if r["label"] == "ai" else 0.0

    # 缺失值用列中位数补，再标准化
    col_med = np.nanmedian(X, axis=0)
    col_med = np.where(np.isnan(col_med), 0.0, col_med)
    inds = np.where(np.isnan(X))
    X[inds] = np.take(col_med, inds[1])

    mean = X.mean(axis=0)
    std = X.std(axis=0)
    std[std < 1e-9] = 1.0

    # 丢掉"几乎常量"的特征。
    # 这类特征标准差极小，训练集里看着稳，一遇到新文本就给出 z=-6 这种爆炸值，
    # 单个特征就能把结论掀翻（圣墟那 3 章误判就是这么来的）。
    with np.errstate(divide="ignore", invalid="ignore"):
        den = np.abs(mean).copy()
        den[den < 1e-6] = 1e-9
        cv = np.where(np.abs(mean) > 1e-6, std / den, 1.0)
    keep = cv >= MIN_CV
    flat = [feat_ids[i] for i in range(len(feat_ids)) if not keep[i]]
    if flat:
        print("  丢弃近似常量特征（变异系数 < %.2f）：%s" % (MIN_CV, "、".join(flat)))
        feat_ids = [f for i, f in enumerate(feat_ids) if keep[i]]
        X = X[:, keep]
        mean = mean[keep]
        std = std[keep]

    # 标准化后强行截断，任何一项都不能单独主导结论
    Xs = np.clip((X - mean) / std, -Z_CLIP, Z_CLIP)

    print("  最终使用特征 %d 项" % len(feat_ids))

    return feat_ids, Xs, y, {"ai": n_ai, "human": n_hu, "total": len(rows)}, mean, std, col_med


# ---------------------------------------------------------------- 模型


def sigmoid(z):
    z = np.clip(z, -35.0, 35.0)
    return 1.0 / (1.0 + np.exp(-z))


def class_weights(y):
    """按类别频次倒数加权，避免真人类样本多就把模型带偏"""
    n = float(len(y))
    n1 = max(1.0, float(y.sum()))
    n0 = max(1.0, n - n1)
    w1 = n / (2.0 * n1)
    w0 = n / (2.0 * n0)
    sw = np.where(y > 0.5, w1, w0)
    return sw / sw.mean()


def fit_logreg(X, y, l2=1e-3, epochs=3000, lr=0.5):
    """全批量梯度下降 + L2。57 维几千条样本，秒级收敛。"""
    n, d = X.shape
    w = np.zeros(d)
    b = 0.0
    sw = class_weights(y)
    for ep in range(epochs):
        p = sigmoid(X @ w + b)
        diff = (p - y) * sw
        gw = (X.T @ diff) / n + l2 * w
        gb = diff.mean()
        w -= lr * gw
        b -= lr * gb
    return w, float(b)


def predict_proba(X, w, b):
    return sigmoid(X @ w + b)


def auc_score(y, p):
    pos = p[y > 0.5]
    neg = p[y <= 0.5]
    if len(pos) == 0 or len(neg) == 0:
        return None
    # 秩和公式，O(n log n)
    order = np.argsort(np.concatenate([pos, neg]))
    ranks = np.empty_like(order, dtype=np.float64)
    ranks[order] = np.arange(1, len(order) + 1)
    r_pos = ranks[: len(pos)].sum()
    return float((r_pos - len(pos) * (len(pos) + 1) / 2.0) / (len(pos) * len(neg)))


def accuracy(y, p, thr=0.5):
    return float(((p >= thr).astype(np.float64) == y).mean())


def best_threshold(y, p):
    best = (0.5, accuracy(y, p, 0.5))
    for t in np.arange(0.2, 0.81, 0.02):
        a = accuracy(y, p, t)
        if a > best[1]:
            best = (round(float(t), 2), a)
    return best


def cross_validate(X, y, k=5, l2=1e-3):
    idx = np.arange(len(y))
    rng = np.random.RandomState(42)
    rng.shuffle(idx)
    folds = np.array_split(idx, min(k, len(y)))
    accs, aucs = [], []
    for i in range(len(folds)):
        test = folds[i]
        train = np.concatenate([folds[j] for j in range(len(folds)) if j != i])
        if len(train) < 4 or len(test) == 0:
            continue
        w, b = fit_logreg(X[train], y[train], l2=l2)
        p = predict_proba(X[test], w, b)
        accs.append(accuracy(y[test], p))
        a = auc_score(y[test], p)
        if a is not None:
            aucs.append(a)
    return (float(np.mean(accs)) if accs else None, float(np.mean(aucs)) if aucs else None)


# ---------------------------------------------------------------- 演示


def make_demo(n=400, d=57):
    """合成一批可分的假数据，只用来验证代码能跑通。真实效果请看真数据。"""
    rng = np.random.RandomState(0)
    X, y = [], []
    for i in range(n):
        is_ai = i % 2 == 1
        v = rng.normal(0, 1, d)
        v[0] += 1.2 if is_ai else -1.2      # 假设第 0 维有区分度
        v[1] += 0.9 if is_ai else -0.9
        v[2] += 0.5 if is_ai else -0.5
        X.append(v)
        y.append(1.0 if is_ai else 0.0)
    return np.array(X), np.array(y), ["demo_feat_%d" % i for i in range(d)]


# ---------------------------------------------------------------- 主流程


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", action="store_true", help="用合成数据验证流程")
    ap.add_argument("--file", default=SAMPLES)
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--cv", type=int, default=5)
    ap.add_argument("--l2", type=float, default=1e-3)
    ap.add_argument("--epochs", type=int, default=3000)
    ap.add_argument("--lr", type=float, default=0.3)
    args = ap.parse_args()

    t0 = time.time()
    print("\n  玄武 · 训练（逻辑回归）")
    print("  " + "-" * 52)

    if args.demo:
        X, y, feat_ids = make_demo()
        mean = np.zeros(len(feat_ids))
        std = np.ones(len(feat_ids))
        col_med = np.zeros(len(feat_ids))
        counts = {"ai": int(y.sum()), "human": int((1 - y).sum()), "total": len(y)}
        print("  【演示模式】合成数据，只验证代码能不能跑，不代表真实效果")
    else:
        feat_ids, X, y, counts, mean, std, col_med = load_samples(args.file)

    print("  特征维度：%d" % len(feat_ids))

    # 交叉验证
    cv_acc, cv_auc = cross_validate(X, y, k=args.cv, l2=args.l2)
    if cv_acc is not None:
        print("  %d 折交叉验证：准确率 %.1f%%　AUC %.3f" % (args.cv, cv_acc * 100, cv_auc or 0))

    # 全量训练
    w, b = fit_logreg(X, y, l2=args.l2, epochs=args.epochs, lr=args.lr)
    p = predict_proba(X, w, b)
    thr, acc = best_threshold(y, p)
    auc = auc_score(y, p)
    print("  全量自评：准确率 %.1f%%（阈值 %.2f）　AUC %.3f" % (acc * 100, thr, auc or 0))

    # 最重要的几个特征
    order = np.argsort(-np.abs(w))
    print("\n  权重最大的 10 项（正数=越像 AI，负数=越像人写）：")
    for i in order[:10]:
        print("    %-22s  w=%+.3f" % (feat_ids[i], w[i]))

    model = {
        "version": "1.0.0",
        "type": "logistic",
        "trainedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "samples": counts,
        "demo": bool(args.demo),
        "threshold": thr,
        "zClip": Z_CLIP,
        "intercept": round(b, 6),
        "features": [
            {
                "id": feat_ids[i],
                "mean": round(float(mean[i]), 6),
                "std": round(float(std[i]), 6),
                "w": round(float(w[i]), 6),
            }
            for i in range(len(feat_ids))
        ],
        "metrics": {
            "cvAccuracy": None if cv_acc is None else round(cv_acc, 4),
            "cvAuc": None if cv_auc is None else round(cv_auc, 4),
            "trainAccuracy": round(acc, 4),
            "trainAuc": None if auc is None else round(auc, 4),
        },
    }

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(model, f, ensure_ascii=False, indent=2)

    print("\n  已写入 %s（%d 项特征）" % (os.path.basename(args.out), len(feat_ids)))
    print("  重启 node server.js 生效；想回滚就删掉它。")
    print("  耗时 %.1f 秒\n" % (time.time() - t0))


if __name__ == "__main__":
    main()
