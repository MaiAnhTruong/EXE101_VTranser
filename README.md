# ViT → Projection → T5 Decoder: Image Captioning (README)

Tài liệu này mô tả **kiến trúc**, **luồng dữ liệu**, **shape qua từng lớp**, **tham số train/freeze**, và **cách tính** của mô hình bạn đã xây dựng: **ViT (encoder ảnh, freeze)** → **Dense projection (train)** → **T5 decoder (train)**, với **T5 encoder + shared + lm_head (freeze)**.

> Thiết lập điển hình trong code của bạn: `google/vit-base-patch16-224` (ViT, hidden=768), `VietAI/vit5-base` (T5, d_model=768, d_ff=3072, n_heads=12, n_layers=12), patch 16×16, beam size=3, max_length=35.

---

## 1) Sơ đồ tổng quan (Mermaid)

```mermaid
flowchart LR
    A[Input Image (B,H,W,3)] --> B[Preprocess\nResize 224×224 + Normalize]
    B --> C[ViT Patch Embedding\n14×14=196 patches → 768]
    C --> D[12× ViT Encoder Blocks\nMHSA + FFN (freeze)]
    D --> E[Projection Dense 768→768\n(train)]
    E --> F[ T5 Decoder (12 blocks, train) ]
    subgraph T5 Decoder Block ×12
      F1[Masked Self-Attn] --> F2[Cross-Attn to E]
      F2 --> F3[FFN 768→3072→768]
    end
    F --> G[LM Head 768→Vocab\n(freeze)]
    G --> H1[Loss (train)\nlabels=captions]
    G --> H2[Generate (inference)\nbeam=3, max_len=35]
```

---

## 2) Luồng dữ liệu & Shapes (ví dụ B=2, L=35)

| Bước | Mô tả                                | Shape vào                      | Shape ra                          |
| ---- | ------------------------------------ | ------------------------------ | --------------------------------- |
| 1    | Ảnh đầu vào                          | `(2, 224, 224, 3)`             | —                                 |
| 2    | Chuẩn hoá (ImageNet)                 | `(2, 224, 224, 3)`             | `(2, 224, 224, 3)`                |
| 3    | (Nếu cần) transpose BHWC→BCHW        | `(2, 224, 224, 3)`             | `(2, 3, 224, 224)`                |
| 4    | ViT patchify 16×16 (14×14=196) + pos | `(2, 3, 224, 224)`             | `(2, 196, 768)`                   |
| 5    | ViT Encoder ×12 (freeze)             | `(2, 196, 768)`                | `(2, 196, 768)`                   |
| 6    | Projection Dense 768→768 (train)     | `(2, 196, 768)`                | `(2, 196, 768)` = **H_enc**       |
| 7    | T5 Decoder ×12 (train)               | Captions `(2, 35)` + **H_enc** | Decoder out `(2, 35, 768)`        |
| 8    | LM Head (freeze)                     | `(2, 35, 768)`                 | Logits `(2, 35, V)`               |
| 9    | Loss (train) hoặc Generate (infer)   | —                              | Scalar loss **hoặc** ids `(2, T)` |

> `V` là vocab size của T5; `T` là chiều dài sinh (≤35 tuỳ stop/EOS).

---

## 3) ViT Encoder (đóng băng)

### 3.1 Patch Embedding

* Chia ảnh thành **patch 16×16** → tổng số patch **N = 14×14 = 196**.
* Mỗi patch (16×16×3) ánh xạ thành vector **768** (Conv/Linear, stride=16, kernel=16).
* Cộng **positional embedding**: `(B, 196, 768)`.

### 3.2 12 Transformer Encoder Blocks

Mỗi block có 2 nhánh chính (LayerNorm + Residual):

1. **Multi-Head Self-Attention (MHSA)**

   * Tham số: `W_Q, W_K, W_V ∈ ℝ^{768×768}`, `W_O ∈ ℝ^{768×768}`.
   * 12 heads: `d_head = 768 / 12 = 64`.
   * Tính:
     ( Q=XW_Q,\ K=XW_K,\ V=XW_V \in ℝ^{B,196,768} \Rightarrow ) reshape (→ (B,12,196,64) ).
     (\text{Attn}(Q,K,V)=\text{softmax}(QK^T/\sqrt{64})V ), ghép head → proj `W_O`.
2. **FFN (DenseReluDense)**: `768 → 3072 → 768` (ReLU/GELU).

**Đầu ra ViT (sau block 12)**: `(B, 196, 768)`.

> **Freeze** toàn bộ ViT: không cập nhật trọng số.

---

## 4) Projection Dense (train)

* Lớp: `Dense(768→768, bias=True)`.
* Công thức: ( H_{enc} = H_{vit} W_P + b ).
* Tham số: `768×768 + 768 = 590,592`.
* Shape: `(B, 196, 768) → (B, 196, 768)`.

> Đây là “cầu nối” không gian thị giác → không gian ngôn ngữ T5.

---

## 5) T5 Decoder (train) — 12 blocks

### 5.1 Dữ liệu vào của Decoder (TRAIN)

* Sử dụng `labels=captions` (HF tự **shift-right** và mask PAD).
* **Cross-attn memory** nhận từ **H_enc** của Projection.

### 5.2 Một Decoder Block (lặp ×12)

Mỗi block gồm 3 nhánh (mỗi nhánh kèm LayerNorm + Residual):

1. **Masked Self-Attention** (causal mask tam giác dưới) trên chuỗi decoder `(B, L, 768)`.

   * 12 heads, `d_head=64`.
   * Weights: `(B, 12, L, L)`.
2. **Cross-Attention** với **H_enc** `(B, 196, 768)` từ ViT→Projection.

   * Q từ decoder `(B, L, 768)`, K,V từ encoder `(B, 196, 768)`.
   * Weights: `(B, 12, L, 196)`.
3. **FFN**: `768 → 3072 → 768`.

**Đầu ra Decoder (sau block 12)**: `(B, L, 768)`.

### 5.3 LM Head (freeze)

* Chiếu `768 → V` (vocab) để tính logits.
* Đóng băng trong cấu hình của bạn.

### 5.4 Loss & Generate

* **Train**: Cross-Entropy trên vị trí `labels` ≠ PAD (HF tự xử lý), trả về **loss scalar**.
* **Infer**: Beam search (mặc định beam=3), `max_length=35`, trả về **token ids**.

---

## 6) Tham số: Freeze vs Train (khớp log của bạn)

| Nhóm                     | total params |       trainable |
| ------------------------ | -----------: | --------------: |
| **ViT** (toàn bộ)        |  ~86,389,248 |           **0** |
| **Projection** Dense     |  **590,592** |     **590,592** |
| **T5 (plain)** encoder   | ~112,675,968 |           **0** |
| **T5 (plain)** decoder   | ~113,275,008 | **113,275,008** |
| **T5 (plain)** shared    |  ~27,721,728 |           **0** |
| **T5ForCondGen** encoder | ~112,675,968 |           **0** |
| **T5ForCondGen** decoder | ~113,275,008 | **113,275,008** |
| **T5ForCondGen** shared  |  ~27,721,728 |           **0** |
| **LM head** (CondGen)    |  ~27,721,728 |           **0** |

**Tổng trainable (theo thiết kế):** Projection (0.59M) + 2×Decoder T5 (2×113.275M) ≈ **227,140,608**.

> Lưu ý: Trong thực thi loss/backprop, gradient trực tiếp chảy qua **Projection + Decoder của CondGen**. Nếu muốn “giữ” `T5 (plain)` decoder đồng bộ để debug/soi params, bạn **copy trọng số** từ CondGen → plain sau mỗi bước hoặc mỗi epoch.

---

## 7) Công thức & ví dụ số (rút gọn)

### 7.1 Attention (một head)

* Cho `Q∈ℝ^{L×64}, K∈ℝ^{S×64}, V∈ℝ^{S×64}` (decoder self-attn: `S=L`; cross-attn: `S=196`).
* Trọng số:
  ( A = \text{softmax}(\tfrac{QK^T}{\sqrt{64}}) \in ℝ^{L×S} ).
* Kết quả: ( O = A V \in ℝ^{L×64} ). Ghép 12 head → (ℝ^{L×768}) → `W_O (768×768)`.

### 7.2 FFN

* ( \text{FFN}(x) = W_2, \sigma(W_1 x + b_1) + b_2 ), với `W1∈ℝ^{768×3072}`, `W2∈ℝ^{3072×768}`.

### 7.3 Ví dụ shape (B=2, L=35)

* Self-attn weights: `(2, 12, 35, 35)`; Cross-attn: `(2, 12, 35, 196)`.
* Decoder out: `(2, 35, 768)` → Logits `(2, 35, V)` → Loss scalar.

---

## 8) Pseudo-code forward (đúng với TF implementation)

```python
# Ảnh → ViT (freeze) → Projection (train)
vit_out = vit(pixel_values=images_bchw).last_hidden_state  # (B,196,768)
H_enc   = Dense(768→768)(vit_out)                           # (B,196,768)

if training:
    out = T5ForCondGen(
        input_ids=captions,                 # (B,L)
        encoder_outputs=BaseOutput(H_enc),
        labels=captions,                    # CE loss (ignore PAD)
        training=True,
    )
    loss = out.loss
else:
    gen_ids = T5ForCondGen.generate(
        inputs=start_ids, encoder_outputs=BaseOutput(H_enc),
        num_beams=3, max_length=35,
    )
```

---

## 9) Gợi ý huấn luyện

* **Mixed precision**: `mixed_float16` để tiết kiệm VRAM.
* **LR theo nhóm**: Projection (cao hơn, ví dụ `3e-4`), T5 decoder (thấp hơn, `5e-5`).
* **Weight decay**: tách **bias/LayerNorm** (no-decay) vs còn lại (decay=1e-2).
* **Scheduler**: cosine + warmup (~8% steps, `≥100`).
* **Clip grad**: norm=1.0.
* **Early stopping**: theo `val_loss`.

---

## 10) Các bẫy thường gặp

* **BHWC vs BCHW**: ViT TF thường dùng `(B,3,H,W)`; đã có `_maybe_transpose` trong `call()`.
* **Truyền `encoder_outputs` đúng kiểu**: `TFBaseModelOutput(last_hidden_state=H_enc)`.
* **Đóng băng shared/lm_head**: nếu quên, tổng trainable không khớp ~227M.
* **BLEU**: nhớ `skip_special_tokens=True` và tiền xử lý chữ thường/loại dấu.

---

## 11) Phụ lục: Ký hiệu

* `B`: batch size; `H×W`: kích thước ảnh; `N`: số patch (=196); `L`: chiều dài chuỗi caption; `V`: vocab size.
* `d_model=768`, `n_heads=12`, `d_head=64`, `d_ff=3072`, `n_layers=12`.

---

**Kết luận**: Mô hình hiện tại tận dụng **biểu diễn ảnh toàn cục** của ViT và **khả năng sinh ngôn ngữ** đã pretrain của T5. Phần **learnable cốt lõi** là **Projection + Decoder**, giúp mô hình học cách “nói” về ảnh với chi phí fine-tuning hợp lý và kiểm soát tốt rủi ro overfit.
