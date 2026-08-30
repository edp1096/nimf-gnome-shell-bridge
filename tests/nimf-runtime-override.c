#define _GNU_SOURCE

#include <stdlib.h>
#include <string.h>

char *
c_get_user_runtime_dir (void)
{
  const char *runtime_dir = getenv ("NIMF_TEST_RUNTIME_DIR");

  if (runtime_dir == NULL || runtime_dir[0] == '\0')
    abort ();

  return strdup (runtime_dir);
}
