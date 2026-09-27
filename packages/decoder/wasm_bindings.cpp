// Note: Requires C++17 or newer for Emscripten Embind
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <stdint.h>
#include <vector>
#include <cstring>

// Include all the decoder headers
#include "bcn.h"
#include "pvrtc.h"
#include "etc.h"
#include "atc.h"
#include "astc.h"
#include "crunch.h"
#include "unitycrunch.h"
#include "color.h"

using namespace emscripten;

// Helper function to validate dimensions
bool validate_dimensions(uint32_t width, uint32_t height) {
    if (width == 0 || height == 0) {
        return false;
    }
    // Prevent integer overflow in size calculation
    if (width > UINT32_MAX / height || width * height > UINT32_MAX / 4) {
        return false;
    }
    return true;
}

// Generic decoder wrapper for simple decoders - using typed array for binary-safe data transfer
template<typename DecodeFunc>
val decode_generic(val typedArray, uint32_t width, uint32_t height, DecodeFunc decode_func) {
    // Validate input
    if (typedArray.isNull() || typedArray.isUndefined()) {
        return val::null();
    }
    
    if (!validate_dimensions(width, height)) {
        return val::null();
    }
    
    // Get length from typed array
    unsigned int length = typedArray["length"].as<unsigned int>();
    if (length == 0) {
        return val::null();
    }
    
    // Copy data from JavaScript typed array to C++ vector (binary-safe)
    std::vector<uint8_t> data(length);
    for (unsigned int i = 0; i < length; ++i) {
        data[i] = typedArray[i].as<uint8_t>();
    }
    
    size_t output_size = static_cast<size_t>(width) * height * 4;
    std::vector<uint8_t> output(output_size);
    
    if (!decode_func(data.data(), width, height, reinterpret_cast<uint32_t*>(output.data()))) {
        return val::null();
    }
    
    return val(typed_memory_view(output.size(), output.data()));
}

// BC decoders
val decode_bc1_wrapper(val typedArray, uint32_t width, uint32_t height) {
    return decode_generic(typedArray, width, height, decode_bc1);
}

// BC3 (DXT5) colour half, always in 4-colour mode (#137). The submodule's decode_bc3
// decodes it with its BC1 block decoder, which switches to 3-colour mode (index 2 =
// midpoint, index 3 = black) when c0 <= c1. That mode belongs to BC1 only: the S3TC spec
// (EXT_texture_compression_s3tc, D3D BC2/BC3) decodes the DXT3/DXT5 colour block as
// though c0 > c1 always. The 565 expansion and integer rounding are the submodule's own
// 4-colour branch, so a c0 > c1 block decodes exactly as before. The fix lives here, not
// in the submodule, which stays pinned to upstream; BC1 keeps the submodule's decoder.
static inline void decode_bc3_color_block(const uint8_t* data, uint32_t* outbuf) {
    uint16_t q0, q1;
    uint32_t indices;
    std::memcpy(&q0, data, 2);
    std::memcpy(&q1, data + 2, 2);
    std::memcpy(&indices, data + 4, 4);
    uint8_t r0, g0, b0, r1, g1, b1;
    rgb565_le(q0, &r0, &g0, &b0);
    rgb565_le(q1, &r1, &g1, &b1);
    const uint_fast32_t c[4] = {
        color(r0, g0, b0, 255),
        color(r1, g1, b1, 255),
        color((r0 * 2 + r1) / 3, (g0 * 2 + g1) / 3, (b0 * 2 + b1) / 3, 255),
        color((r0 + r1 * 2) / 3, (g0 + g1 * 2) / 3, (b0 + b1 * 2) / 3, 255),
    };
    uint_fast32_t d = lton32(indices);
    for (int i = 0; i < 16; i++, d >>= 2)
        outbuf[i] = c[d & 3];
}

// The submodule's decode_bc3 with the colour half above; the alpha half is the
// submodule's decode_bc3_alpha, as before.
static int decode_bc3_four_colour(const uint8_t* data, const long w, const long h,
                                  uint32_t* image) {
    const long num_blocks_x = (w + 3) / 4;
    const long num_blocks_y = (h + 3) / 4;
    uint32_t buffer[16];
    const uint8_t* d = data;
    for (long by = 0; by < num_blocks_y; by++) {
        for (long bx = 0; bx < num_blocks_x; bx++, d += 16) {
            decode_bc3_color_block(d + 8, buffer);
            decode_bc3_alpha(d, buffer, 3);
            copy_block_buffer(bx, by, w, h, 4, 4, buffer, image);
        }
    }
    return 1;
}

val decode_bc3_wrapper(val typedArray, uint32_t width, uint32_t height) {
    return decode_generic(typedArray, width, height, decode_bc3_four_colour);
}

val decode_bc4_wrapper(val typedArray, uint32_t width, uint32_t height) {
    return decode_generic(typedArray, width, height, decode_bc4);
}

val decode_bc5_wrapper(val typedArray, uint32_t width, uint32_t height) {
    return decode_generic(typedArray, width, height, decode_bc5);
}

val decode_bc6_wrapper(val typedArray, uint32_t width, uint32_t height) {
    return decode_generic(typedArray, width, height, decode_bc6);
}

val decode_bc7_wrapper(val typedArray, uint32_t width, uint32_t height) {
    return decode_generic(typedArray, width, height, decode_bc7);
}

// ETC decoders
val decode_etc1_wrapper(val typedArray, uint32_t width, uint32_t height) {
    return decode_generic(typedArray, width, height, decode_etc1);
}

val decode_etc2_wrapper(val typedArray, uint32_t width, uint32_t height) {
    return decode_generic(typedArray, width, height, decode_etc2);
}

val decode_etc2a1_wrapper(val typedArray, uint32_t width, uint32_t height) {
    return decode_generic(typedArray, width, height, decode_etc2a1);
}

val decode_etc2a8_wrapper(val typedArray, uint32_t width, uint32_t height) {
    return decode_generic(typedArray, width, height, decode_etc2a8);
}

// EAC decoders
val decode_eacr_wrapper(val typedArray, uint32_t width, uint32_t height) {
    return decode_generic(typedArray, width, height, decode_eacr);
}

val decode_eacr_signed_wrapper(val typedArray, uint32_t width, uint32_t height) {
    return decode_generic(typedArray, width, height, decode_eacr_signed);
}

val decode_eacrg_wrapper(val typedArray, uint32_t width, uint32_t height) {
    return decode_generic(typedArray, width, height, decode_eacrg);
}

val decode_eacrg_signed_wrapper(val typedArray, uint32_t width, uint32_t height) {
    return decode_generic(typedArray, width, height, decode_eacrg_signed);
}

// ATC decoders
val decode_atc_rgb4_wrapper(val typedArray, uint32_t width, uint32_t height) {
    return decode_generic(typedArray, width, height, decode_atc_rgb4);
}

val decode_atc_rgba8_wrapper(val typedArray, uint32_t width, uint32_t height) {
    return decode_generic(typedArray, width, height, decode_atc_rgba8);
}

// PVRTC decoder (special case with is2bpp parameter)
val decode_pvrtc_wrapper(val typedArray, uint32_t width, uint32_t height, bool is2bpp) {
    // Validate input
    if (typedArray.isNull() || typedArray.isUndefined()) {
        return val::null();
    }
    
    if (!validate_dimensions(width, height)) {
        return val::null();
    }
    
    // Get length from typed array
    unsigned int length = typedArray["length"].as<unsigned int>();
    if (length == 0) {
        return val::null();
    }
    
    // Copy data from JavaScript typed array to C++ vector (binary-safe)
    std::vector<uint8_t> data(length);
    for (unsigned int i = 0; i < length; ++i) {
        data[i] = typedArray[i].as<uint8_t>();
    }
    
    size_t output_size = static_cast<size_t>(width) * height * 4;
    std::vector<uint8_t> output(output_size);
    
    if (!decode_pvrtc(data.data(), width, height, 
                      reinterpret_cast<uint32_t*>(output.data()), is2bpp ? 1 : 0)) {
        return val::null();
    }
    
    return val(typed_memory_view(output.size(), output.data()));
}

// ASTC decoder (special case with block dimensions)
val decode_astc_wrapper(val typedArray, uint32_t width, uint32_t height, 
                        uint32_t block_width, uint32_t block_height) {
    // Validate input
    if (typedArray.isNull() || typedArray.isUndefined()) {
        return val::null();
    }
    
    if (!validate_dimensions(width, height)) {
        return val::null();
    }
    if (block_width == 0 || block_height == 0 || block_width > 12 || block_height > 12) {
        return val::null();
    }
    
    // Get length from typed array
    unsigned int length = typedArray["length"].as<unsigned int>();
    if (length == 0) {
        return val::null();
    }
    
    // Copy data from JavaScript typed array to C++ vector (binary-safe)
    std::vector<uint8_t> data(length);
    for (unsigned int i = 0; i < length; ++i) {
        data[i] = typedArray[i].as<uint8_t>();
    }
    
    size_t output_size = static_cast<size_t>(width) * height * 4;
    std::vector<uint8_t> output(output_size);
    
    if (!decode_astc(data.data(), width, height, 
                     block_width, block_height, reinterpret_cast<uint32_t*>(output.data()))) {
        return val::null();
    }
    
    return val(typed_memory_view(output.size(), output.data()));
}

// Crunch unpack - using typed array for binary-safe data transfer
val unpack_crunch_wrapper(val typedArray) {
    // Validate input
    if (typedArray.isNull() || typedArray.isUndefined()) {
        return val::null();
    }
    
    // Get length from typed array
    unsigned int length = typedArray["length"].as<unsigned int>();
    if (length == 0) {
        return val::null();
    }
    
    // Copy data from JavaScript typed array to C++ vector (binary-safe)
    std::vector<uint8_t> data(length);
    for (unsigned int i = 0; i < length; ++i) {
        data[i] = typedArray[i].as<uint8_t>();
    }
    
    void* ret = nullptr;
    uint32_t retSize = 0;
    
    if (!crunch_unpack_level(data.data(), length, 0, &ret, &retSize)) {
        return val::null();
    }
    
    std::vector<uint8_t> output(retSize);
    std::memcpy(output.data(), ret, retSize);
    delete[] static_cast<uint8_t*>(ret);
    
    return val(typed_memory_view(output.size(), output.data()));
}

// Unity Crunch unpack - using typed array for binary-safe data transfer
val unpack_unity_crunch_wrapper(val typedArray) {
    // Validate input
    if (typedArray.isNull() || typedArray.isUndefined()) {
        return val::null();
    }
    
    // Get length from typed array
    unsigned int length = typedArray["length"].as<unsigned int>();
    if (length == 0) {
        return val::null();
    }
    
    // Copy data from JavaScript typed array to C++ vector (binary-safe)
    std::vector<uint8_t> data(length);
    for (unsigned int i = 0; i < length; ++i) {
        data[i] = typedArray[i].as<uint8_t>();
    }
    
    void* ret = nullptr;
    uint32_t retSize = 0;
    
    if (!unity_crunch_unpack_level(data.data(), length, 0, &ret, &retSize)) {
        return val::null();
    }
    
    std::vector<uint8_t> output(retSize);
    std::memcpy(output.data(), ret, retSize);
    delete[] static_cast<uint8_t*>(ret);
    
    return val(typed_memory_view(output.size(), output.data()));
}

// Emscripten bindings
EMSCRIPTEN_BINDINGS(texture2ddecoder) {
    function("decode_bc1", &decode_bc1_wrapper);
    function("decode_bc3", &decode_bc3_wrapper);
    function("decode_bc4", &decode_bc4_wrapper);
    function("decode_bc5", &decode_bc5_wrapper);
    function("decode_bc6", &decode_bc6_wrapper);
    function("decode_bc7", &decode_bc7_wrapper);
    function("decode_pvrtc", &decode_pvrtc_wrapper);
    function("decode_etc1", &decode_etc1_wrapper);
    function("decode_etc2", &decode_etc2_wrapper);
    function("decode_etc2a1", &decode_etc2a1_wrapper);
    function("decode_etc2a8", &decode_etc2a8_wrapper);
    function("decode_eacr", &decode_eacr_wrapper);
    function("decode_eacr_signed", &decode_eacr_signed_wrapper);
    function("decode_eacrg", &decode_eacrg_wrapper);
    function("decode_eacrg_signed", &decode_eacrg_signed_wrapper);
    function("decode_atc_rgb4", &decode_atc_rgb4_wrapper);
    function("decode_atc_rgba8", &decode_atc_rgba8_wrapper);
    function("decode_astc", &decode_astc_wrapper);
    function("unpack_crunch", &unpack_crunch_wrapper);
    function("unpack_unity_crunch", &unpack_unity_crunch_wrapper);
}

