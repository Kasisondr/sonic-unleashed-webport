// Deliberately compile the untouched upstream context to capture portability errors.
#define PPC_CONFIG_H_INCLUDED
#define PPC_IMAGE_BASE 0x82000000ull
#define PPC_IMAGE_SIZE 0x2000000ull
#define PPC_CODE_BASE 0x82000000ull
#include "ppc_context.h"
int main() { PPCContext context{}; return context.r3.u32; }
