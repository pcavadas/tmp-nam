// Player's zero-input skip must be invisible: output bit-identical to running the
// model on every block, across silence gaps (including -0.0) and varied blocks.
// Engine and model both at 48 kHz so Player feeds the model the caller's blocks.
#include <cassert>
#include <cmath>
#include <cstring>
#include <iostream>
#include <random>
#include <string>
#include <vector>

#include "../nam_player.h"
#include "NAM/activations.h"
#include "NAM/get_dsp.h"
#include "NAM/slimmable.h"
#include "json.hpp"
#include "nam_test_models.h"

namespace {

using nlohmann::json;

std::vector<float> signal_with_gaps() {
  std::vector<float> x(4 * 48000, 0.0f);
  std::mt19937 rng(3);
  std::uniform_real_distribution<float> noise(-0.05f, 0.05f);
  for (size_t i = 0; i < x.size(); i++) {
    const bool silent = (i >= 48000 && i < 2 * 48000 + 24000) || (i >= 3 * 48000 && i < 3 * 48000 + 9000);
    x[i] = silent ? ((i % 5 == 0) ? -0.0f : 0.0f) : 0.3f * std::sin(0.02f * static_cast<float>(i)) + noise(rng);
  }
  return x;
}

// Reference: the same preparation Player::prepare performs, then every block.
std::vector<float> reference(const json& model, double size, const std::vector<float>& input, const int* blocks,
                             size_t nblocks) {
  nam::DspLoadOptions options;
  options.prewarm = false;
  auto dsp = nam::get_dsp(model, options);
  dsp->SetPrewarmOnReset(false);
  if (auto* slim = dynamic_cast<nam::SlimmableModel*>(dsp.get())) slim->SetSlimmableSize(size);
  dsp->ResetAndPrewarm(48000.0, 256);
  float zero_in = 0.0f, zero_out = 0.0f;
  float* zi[1] = {&zero_in};
  float* zo[1] = {&zero_out};
  dsp->process(zi, zo, 0);
  std::vector<float> in = input, out(input.size());
  size_t pos = 0, b = 0;
  while (pos < in.size()) {
    const int n = static_cast<int>(std::min<size_t>(static_cast<size_t>(blocks[b++ % nblocks]), in.size() - pos));
    float* ip[1] = {in.data() + pos};
    float* op[1] = {out.data() + pos};
    dsp->process(ip, op, n);
    pos += static_cast<size_t>(n);
  }
  return out;
}

void check(const std::string& label, const json& model, double size, bool expect_skip) {
  static const int kBlocks[] = {32, 1, 7, 64, 35, 256, 13, 32};
  const auto input = signal_with_gaps();
  nam::DspLoadOptions options;
  options.prewarm = false;
  tmp_nam::Options popt;
  popt.engine_rate = 48000;
  popt.max_block = 256;
  popt.size = size;
  tmp_nam::Player player(nam::get_dsp(model, options), popt);
  std::vector<float> out(input.size());
  size_t pos = 0, b = 0;
  while (pos < input.size()) {
    const size_t n = std::min<size_t>(static_cast<size_t>(kBlocks[b++ % 8]), input.size() - pos);
    player.process(input.data() + pos, out.data() + pos, n);
    pos += n;
  }
  const auto want = reference(model, size, input, kBlocks, 8);
  assert(std::memcmp(out.data(), want.data(), out.size() * sizeof(float)) == 0);
  std::cout << label << ": bit-identical, skipped " << player.skipped_model_frames() << " model frames\n";
  assert(expect_skip ? player.skipped_model_frames() > 0 : player.skipped_model_frames() == 0);
}

}  // namespace

int main() {
  nam::activations::Activation::enable_fast_tanh();
  const auto a2 = nam_test::a2_container(21);
  const auto a1 = nam_test::a1_model(8, 4, 23);
#if defined(NAM_ENABLE_A2_FAST)
  check("A2 size 0 (a2_fast<3>)", a2, 0.0, true);
  check("A2 size 1 (a2_fast<8>)", a2, 1.0, true);
#endif
#if defined(NAM_ENABLE_A1_FAST) && defined(__aarch64__)
  check("A1 8/4 (a1_fast<8,4>)", a1, 1.0, true);
#else
  check("A1 8/4 (generic)", a1, 1.0, false);
#endif
  // The generic WaveNet never skips (its kernels round differently per block size).
  auto generic = a1;
  generic["config"]["layers"][0]["bottleneck"] = 8;  // off the A1 fast-path shape
  check("generic WaveNet", generic, 1.0, false);
  std::cout << "NAM zero-input skip: PASS\n";
  return 0;
}
